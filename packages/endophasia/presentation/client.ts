// Source-only Endophasia presentation layer, built on coding-agent's experimental service sources. It is not part of
// the @endophasia/core build or package exports. Like runtime/, it resolves @earendil-works/* imports through
// tsconfig paths: load it with coding-agent's source resolver preloaded (see runtime/server.ts).
import type { Context, ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ByteTransportFactory, Client } from "@earendil-works/pi-client";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerConnectionState,
	type SessionAttachmentState,
} from "@earendil-works/pi-coding-agent/experimental/services/connection";
import { Models, type ModelsState } from "@earendil-works/pi-coding-agent/experimental/services/models";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
} from "@earendil-works/pi-coding-agent/experimental/services/sessions";
import { Transcript, type TranscriptState } from "@earendil-works/pi-coding-agent/experimental/services/transcript";
import { EndophasiaInspectorV0 } from "../src/inspector-service.ts";
import { EndophasiaMissionTraceV0, type MissionTraceObservationV0 } from "../src/mission-trace-service.ts";
import {
	EndophasiaRuntimeFactsV0,
	type OperationOutcomeV0,
	type RuntimeMetricsV0,
} from "../src/runtime-facts-service.ts";
import type { SessionOverviewV0 } from "../src/session-overview.ts";
import {
	EndophasiaUsageV0,
	type UsageLedgerPageV0,
	type UsageLedgerQueryV0,
	type UsageObservationV0,
} from "../src/usage-service.ts";

/**
 * Read-only presentation view of one Endophasia server. Each state is Pi's own replicated state with its own
 * consistency; together they are not one atomic snapshot. The only lifecycle control is which Session is observed.
 * This is an API contract for presentations, not a sandbox against code that imports lower-level Pi services.
 */
export interface EndophasiaPresentationClientV0 {
	readonly connection: ReplicatedState<ServerConnectionState>;
	/** Pi's attachment lifecycle: detached, attaching, then attached or degraded. */
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly sessions: ReplicatedState<SessionDirectoryState>;
	/** The attached Session's main-lane transcript. */
	readonly transcript: ReplicatedState<TranscriptState>;
	/** The attached Session's model configuration. */
	readonly models: ReplicatedState<ModelsState>;
	/**
	 * The attached Session worker's live Mission Trace, observed since that worker activated. It is not durable history,
	 * and its sequence orders events without timing them. Like every Session state, a value may briefly belong to the
	 * previous attachment while the Session changes: present it only while attachment reports this Session attached.
	 */
	readonly missionTrace: ReplicatedState<MissionTraceObservationV0>;
	/**
	 * The attached Session's most recent durable usage records, live. This is durable Session history, bounded to a
	 * trailing window: hasEarlierRows says older rows exist, which usagePage() still reads. Like every Session state, a
	 * value may briefly belong to the previous attachment while the Session changes.
	 */
	readonly usage: ReplicatedState<UsageObservationV0>;
	/**
	 * Attach a Session and wait until its services, including the Endophasia Inspector, Mission Trace, Runtime Facts and
	 * Usage, hydrate. A worker missing any of them attaches degraded.
	 */
	attach(sessionId: string, context: Context): Promise<void>;
	/** Detach the current Session and wait until its services are released. */
	detach(context: Context): Promise<void>;
	/** A fresh per-lane Session Overview captured by the attached worker on every call. */
	sessionOverview(context: Context): Promise<SessionOverviewV0>;
	/**
	 * The attached Session's cumulative accounting, captured by its worker on every call. It is not live, not attributable
	 * to any lane, not current context occupancy, not a provider invoice, and not guaranteed monotonic.
	 */
	runtimeMetrics(context: Context): Promise<RuntimeMetricsV0>;
	/**
	 * The durable terminal outcome of one operation in the attached Session, read on every call. `null` means only that no
	 * durable result exists for this ID at this read.
	 */
	operationOutcome(operationId: string, context: Context): Promise<OperationOutcomeV0 | null>;
	/**
	 * A forward page of the attached Session's durable usage rows after an exclusive sequence cursor, read on every call.
	 * Without a query it reads from the start with the default limit. Not an atomic snapshot of the ledger.
	 */
	usagePage(query: UsageLedgerQueryV0 | undefined, context: Context): Promise<UsageLedgerPageV0>;
	/** Dispose the service bindings and the Pi client. Every call returns the same disposal promise. */
	dispose(): Promise<void>;
}

export interface OpenEndophasiaPresentationClientV0Options {
	readonly serverId: string;
	readonly transportFactory: ByteTransportFactory;
	/** Observes client listener, service-source and binding errors. Exceptions it throws are ignored. */
	readonly onError?: (error: Error) => void;
}

/** Connect to an Endophasia server over any Pi byte transport and bind its read-only presentation services. */
export async function openEndophasiaPresentationClientV0(
	options: OpenEndophasiaPresentationClientV0Options,
): Promise<EndophasiaPresentationClientV0> {
	// Diagnostic observers cannot affect client, service-source or attachment state.
	const onError = (error: Error): void => {
		try {
			options.onError?.(error);
		} catch {
			// A throwing observer is ignored, as Pi's listener error handlers are.
		}
	};
	const client = await Client.connect({
		serverId: options.serverId,
		transportFactory: options.transportFactory,
		onListenerError: onError,
	});
	const server = createServerServiceSource(client, { onError });
	const session = createSessionServiceSource(client, { onError });
	const disposeResources = async (): Promise<void> => {
		// Each source disposes the bindings it opened.
		const results = await Promise.allSettled([
			server.dispose(BACKGROUND_CONTEXT),
			session.dispose(BACKGROUND_CONTEXT),
		]);
		results.push(...(await Promise.allSettled([client.dispose()])));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose Endophasia presentation client");
	};
	// Every caller, including concurrent ones, awaits the same cleanup and observes its result.
	let disposal: Promise<void> | undefined;
	const dispose = (): Promise<void> => {
		disposal ??= disposeResources();
		return disposal;
	};

	try {
		const serverServices = server.open({
			services: [SessionDirectory, SessionManagement],
			assertAccess() {},
			onError,
		});
		const sessionServices = session.open({
			services: [
				Transcript,
				Models,
				EndophasiaInspectorV0,
				EndophasiaMissionTraceV0,
				EndophasiaRuntimeFactsV0,
				EndophasiaUsageV0,
			],
			assertAccess() {},
			onError,
		});
		const management = serverServices.use(SessionManagement);
		const inspector = sessionServices.use(EndophasiaInspectorV0);
		const runtimeFacts = sessionServices.use(EndophasiaRuntimeFactsV0);
		const usage = sessionServices.use(EndophasiaUsageV0);
		const presentation: EndophasiaPresentationClientV0 = {
			connection: server.connection,
			attachment: session.attachment,
			sessions: serverServices.use(SessionDirectory).state,
			transcript: sessionServices.use(Transcript).state,
			models: sessionServices.use(Models).state,
			missionTrace: sessionServices.use(EndophasiaMissionTraceV0).state,
			usage: usage.state,
			async attach(sessionId, context) {
				await management.attach(sessionId, context);
				await session.whenAttached(sessionId, context);
			},
			async detach(context) {
				await management.detach(context);
				await session.whenDetached(context);
			},
			sessionOverview: (context) => inspector.sessionOverview(context),
			runtimeMetrics: (context) => runtimeFacts.runtimeMetrics(context),
			operationOutcome: (operationId, context) => runtimeFacts.operationOutcome(operationId, context),
			// A remote argument cannot be undefined: the default query crosses as an empty object.
			usagePage: (query, context) => usage.page(query ?? {}, context),
			dispose,
		};
		await Promise.all([serverServices.ready(BACKGROUND_CONTEXT), sessionServices.ready(BACKGROUND_CONTEXT)]);
		return presentation;
	} catch (error) {
		try {
			await dispose();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Endophasia presentation client startup and cleanup failed");
		}
		throw error;
	}
}
