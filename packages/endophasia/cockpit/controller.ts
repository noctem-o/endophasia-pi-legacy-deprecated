// DOM-free Standard Cockpit v0 controller. Runtime and Session truth stays in the Presentation Client's replicated
// states, which the renderer reads directly; the controller holds only presentation-local state: a pending
// selection, the latest explicit Session Overview capture and ephemeral diagnostics. Replicated-state updates only
// mark regions dirty, and one scheduled frame renders each burst.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EndophasiaPresentationClientV0 } from "../presentation/client.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";

/** The part of Presentation Client v0 the cockpit uses. It never reaches below this API. */
export type CockpitPresentation = Pick<
	EndophasiaPresentationClientV0,
	"connection" | "attachment" | "sessions" | "transcript" | "models" | "attach" | "detach" | "sessionOverview"
>;

export type CockpitRegion = "status" | "sessions" | "transcript" | "inspector" | "diagnostics";

export type OverviewCapture =
	| { readonly status: "none" }
	| { readonly status: "capturing"; readonly sessionId: string }
	| {
			readonly status: "captured";
			readonly sessionId: string;
			readonly overview: SessionOverviewV0;
			/** When this cockpit received the capture; not an atomic server-side instant. */
			readonly capturedAt: number;
	  }
	| { readonly status: "failed"; readonly sessionId: string; readonly message: string };

export interface Diagnostic {
	readonly at: number;
	readonly message: string;
}

export interface CockpitControllerOptions {
	readonly presentation: CockpitPresentation;
	/** Called with the regions changed since the last render. */
	readonly render: (regions: ReadonlySet<CockpitRegion>) => void;
	/** Schedules one render pass, e.g. on the next animation frame. */
	readonly schedule: (callback: () => void) => void;
	readonly now?: () => number;
	readonly context?: Context;
}

const MAX_DIAGNOSTICS = 5;
const MAX_DIAGNOSTIC_LENGTH = 500;
const ALL_REGIONS: readonly CockpitRegion[] = ["status", "sessions", "transcript", "inspector", "diagnostics"];

export class CockpitController {
	readonly presentation: CockpitPresentation;
	private readonly renderRegions: (regions: ReadonlySet<CockpitRegion>) => void;
	private readonly schedule: (callback: () => void) => void;
	private readonly now: () => number;
	private readonly context: Context;
	private readonly unsubscribes: (() => void)[] = [];
	private readonly dirty = new Set<CockpitRegion>();
	private scheduled = false;
	private disposed = false;
	private pending: string | undefined;
	private queuedSelection: string | undefined;
	private overviewValue: OverviewCapture = { status: "none" };
	/** Incremented whenever the observed Session changes or a capture starts; late captures compare against it. */
	private overviewGeneration = 0;
	private observedSessionId: string | undefined;
	private readonly diagnosticsValue: Diagnostic[] = [];

	constructor(options: CockpitControllerOptions) {
		this.presentation = options.presentation;
		this.renderRegions = options.render;
		this.schedule = options.schedule;
		this.now = options.now ?? Date.now;
		this.context = options.context ?? BACKGROUND_CONTEXT;
		const { connection, attachment, sessions, transcript, models } = this.presentation;
		this.observedSessionId = attachedSessionId(this.presentation);
		this.unsubscribes.push(
			connection.subscribe(() => this.invalidate("status", "inspector")),
			attachment.subscribe(() => {
				this.followAttachment();
				this.invalidate("status", "sessions", "transcript", "inspector");
			}),
			sessions.subscribe(() => this.invalidate("sessions")),
			transcript.subscribe(() => this.invalidate("transcript", "inspector")),
			models.subscribe(() => this.invalidate("status", "inspector")),
		);
		this.invalidate(...ALL_REGIONS);
	}

	/** Local intent while attach() is pending; never shown as the attached Session. */
	get pendingSelection(): string | undefined {
		return this.pending;
	}

	get overview(): OverviewCapture {
		return this.overviewValue;
	}

	get diagnostics(): readonly Diagnostic[] {
		return this.diagnosticsValue;
	}

	/**
	 * Observe a Session. Requests are serialized: while one attach() is pending, only the latest further selection
	 * is kept and runs after it.
	 */
	select(sessionId: string): void {
		if (this.disposed) return;
		if (this.pending !== undefined) {
			this.queuedSelection = sessionId === this.pending ? undefined : sessionId;
			return;
		}
		if (attachedSessionId(this.presentation) === sessionId) return;
		void this.runSelection(sessionId);
	}

	/**
	 * Whether Detach may run: Pi reports a current attachment, attached or degraded (its services failed to hydrate,
	 * but it still holds the Session), and no selection is pending.
	 */
	get canDetach(): boolean {
		const status = this.presentation.attachment.value?.status;
		return !this.disposed && this.pending === undefined && (status === "attached" || status === "degraded");
	}

	/** Stop observing the current Session, including a degraded one. */
	async detach(): Promise<void> {
		if (!this.canDetach) return;
		try {
			await this.presentation.detach(this.context);
		} catch (error) {
			this.report(error);
		}
	}

	/** Capture a fresh Session Overview for the attached Session; stale captures are discarded. */
	async refreshOverview(): Promise<void> {
		const sessionId = attachedSessionId(this.presentation);
		if (this.disposed || sessionId === undefined) return;
		const generation = ++this.overviewGeneration;
		this.setOverview({ status: "capturing", sessionId });
		let next: OverviewCapture;
		try {
			const overview = await this.presentation.sessionOverview(this.context);
			next = { status: "captured", sessionId, overview, capturedAt: this.now() };
		} catch (error) {
			next = { status: "failed", sessionId, message: boundMessage(error) };
		}
		// A capture that finishes after the observed Session changed, or after a newer capture started, is dropped.
		if (
			this.disposed ||
			generation !== this.overviewGeneration ||
			attachedSessionId(this.presentation) !== sessionId
		) {
			return;
		}
		this.setOverview(next);
	}

	/** Record an ephemeral presentation diagnostic. Never throws. */
	report(error: unknown): void {
		try {
			if (this.disposed) return;
			this.diagnosticsValue.unshift({ at: this.now(), message: boundMessage(error) });
			this.diagnosticsValue.length = Math.min(this.diagnosticsValue.length, MAX_DIAGNOSTICS);
			this.invalidate("diagnostics");
		} catch {
			// Diagnostics cannot affect the Presentation Client or the cockpit lifecycle.
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		this.dirty.clear();
	}

	private async runSelection(sessionId: string): Promise<void> {
		this.pending = sessionId;
		// The inspector shows the pending request and whether Detach is available.
		this.invalidate("sessions", "status", "inspector");
		try {
			await this.presentation.attach(sessionId, this.context);
			if (this.queuedSelection === undefined) void this.refreshOverview();
		} catch (error) {
			this.report(error);
		} finally {
			this.pending = undefined;
			this.invalidate("sessions", "status", "inspector");
		}
		const next = this.queuedSelection;
		this.queuedSelection = undefined;
		if (next !== undefined && !this.disposed) this.select(next);
	}

	private followAttachment(): void {
		const sessionId = attachedSessionId(this.presentation);
		if (sessionId === this.observedSessionId) return;
		this.observedSessionId = sessionId;
		// A different (or no) observed Session invalidates any capture, including one still in flight.
		this.overviewGeneration++;
		this.overviewValue = { status: "none" };
	}

	private setOverview(value: OverviewCapture): void {
		this.overviewValue = value;
		this.invalidate("inspector");
	}

	private invalidate(...regions: CockpitRegion[]): void {
		if (this.disposed) return;
		for (const region of regions) this.dirty.add(region);
		if (this.scheduled) return;
		this.scheduled = true;
		this.schedule(() => {
			this.scheduled = false;
			if (this.disposed || this.dirty.size === 0) return;
			const regions = new Set(this.dirty);
			this.dirty.clear();
			try {
				this.renderRegions(regions);
			} catch (error) {
				this.report(error);
			}
		});
	}
}

function attachedSessionId(presentation: CockpitPresentation): string | undefined {
	const attachment = presentation.attachment.value;
	return attachment?.status === "attached" ? attachment.sessionId : undefined;
}

function boundMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > MAX_DIAGNOSTIC_LENGTH ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : message;
}
