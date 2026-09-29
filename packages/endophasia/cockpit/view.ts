// Imperative DOM renderer for Standard Cockpit v0. It keeps one stable root per panel and redraws only the regions
// the controller marks dirty. All runtime, model and tool text is untrusted: it is written with textContent and
// never parsed as HTML.
import type { CockpitController, CockpitRegion } from "./controller.ts";
import {
	type BoundedText,
	type ContentBlockView,
	type ContinuityEntriesView,
	type EntryView,
	formatClock,
	projectAttachment,
	projectConnection,
	projectContinuity,
	projectMessage,
	projectMissionTrace,
	projectModels,
	projectOperation,
	projectQueues,
	projectRuntimeMetrics,
	projectRuntimeProfile,
	projectSessionOverview,
	projectSessions,
	projectUsage,
	projectVisibleTranscript,
	type StatusView,
	type VisibleEntryCache,
} from "./view-model.ts";

/** Previews at most this long start expanded. */
const OPEN_PREVIEW_LENGTH = 400;
/** Distance from the bottom within which new transcript content keeps the view pinned to the end. */
const PINNED_SCROLL_SLACK = 48;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className !== undefined) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function pill(status: StatusView, prefix?: string): HTMLElement {
	const element = el("span", `pill tone-${status.tone}`);
	element.append(
		el("span", "pill-glyph", status.glyph),
		el("span", "pill-label", prefix ? `${prefix} ${status.label}` : status.label),
	);
	if (status.detail !== undefined) element.append(el("span", "pill-detail", status.detail));
	return element;
}

function field(label: string, value: string, className?: string): HTMLElement {
	const row = el("div", "field");
	row.append(el("dt", undefined, label), el("dd", className, value));
	return row;
}

function boundedPre(text: BoundedText, className = "preview"): HTMLElement {
	const wrapper = el("div", "bounded");
	wrapper.append(el("pre", className, text.text));
	if (text.truncated) {
		wrapper.append(
			el(
				"div",
				"truncated",
				`Preview truncated · ${text.text.length.toLocaleString("en-US")} of ${text.totalLength.toLocaleString("en-US")} characters shown`,
			),
		);
	}
	return wrapper;
}

function renderBlock(block: ContentBlockView): HTMLElement {
	switch (block.kind) {
		case "text": {
			const wrapper = el("div", "bounded");
			wrapper.append(el("p", "text", block.text.text));
			if (block.text.truncated) wrapper.append(el("div", "truncated", "Text truncated for display"));
			return wrapper;
		}
		case "reasoning":
			return el("div", "block-note reasoning", "◇ Reasoning activity · content not shown");
		case "tool-call": {
			const details = el("details", "tool-call");
			details.open = block.args.text.length <= OPEN_PREVIEW_LENGTH;
			details.append(el("summary", undefined, `Tool call · ${block.toolName}`), boundedPre(block.args));
			return details;
		}
		case "image":
			return el("div", "block-note", `Image · ${block.mimeType} · not rendered`);
		case "preview": {
			const details = el("details", "payload");
			details.open = block.text.text.length <= OPEN_PREVIEW_LENGTH;
			details.append(el("summary", undefined, block.label), boundedPre(block.text));
			return details;
		}
		case "error":
			return el("div", "block-error", block.text.text);
		case "note":
			return el("div", "block-note source-note", `△ ${block.text}`);
		case "unsupported":
			return el("div", "block-note", block.label);
	}
}

function renderCard(view: EntryView, extraClass?: string): HTMLElement {
	const card = el("article", `card kind-${view.kind}${extraClass ? ` ${extraClass}` : ""}`);
	const header = el("header", "card-header");
	header.append(el("span", "card-title", view.title));
	for (const meta of view.meta) header.append(el("span", "chip", meta));
	card.append(header);
	for (const block of view.blocks) card.append(renderBlock(block));
	return card;
}

interface RenderedEntry {
	readonly source: unknown;
	readonly element: HTMLElement;
}

export interface MountedCockpit {
	/** Redraw the given regions; the controller calls this once per scheduled frame. */
	render(regions: ReadonlySet<CockpitRegion>): void;
}

/** Build the cockpit's stable panel roots inside root. */
export function mountCockpit(root: HTMLElement, getController: () => CockpitController): MountedCockpit {
	root.replaceChildren();
	const shell = el("div", "cockpit");
	const statusBar = el("header", "statusbar");
	const sessionsPanel = el("nav", "panel sessions");
	sessionsPanel.setAttribute("aria-label", "Sessions");
	const transcriptPanel = el("main", "panel transcript");
	const inspectorPanel = el("aside", "panel inspector");
	inspectorPanel.setAttribute("aria-label", "Inspector");
	const footer = el("footer", "footer");
	shell.append(statusBar, sessionsPanel, transcriptPanel, inspectorPanel, footer);
	root.append(shell);

	// Sessions panel.
	const sessionsHeading = el("h2", "panel-title", "Sessions");
	const sessionsList = el("ul", "session-list");
	const sessionsEmpty = el("p", "empty", "No durable Sessions.");
	sessionsPanel.append(sessionsHeading, sessionsList, sessionsEmpty);

	// Transcript panel: heading, live operation strip, scrolling entry list.
	const transcriptHeader = el("div", "transcript-header");
	transcriptHeader.append(
		el("h2", "panel-title", "Main-lane transcript"),
		el("span", "panel-subtitle", "Replicated main-lane state · not the provider prompt"),
	);
	const operationStrip = el("section", "operation-strip");
	operationStrip.setAttribute("aria-label", "Main-lane operation");
	operationStrip.setAttribute("aria-live", "polite");
	const transcriptScroll = el("div", "transcript-scroll");
	const entryList = el("div", "entry-list");
	const streamingSlot = el("div", "streaming-slot");
	const transcriptEmpty = el("p", "empty");
	transcriptScroll.append(transcriptEmpty, entryList, streamingSlot);
	transcriptPanel.append(transcriptHeader, operationStrip, transcriptScroll);
	const renderedEntries = new Map<string, RenderedEntry>();
	// Projections of immutable entries, so each streamed update projects only new or replaced entries.
	const projections: VisibleEntryCache = new WeakMap();

	// Inspector sections.
	const connectionSection = el("section", "inspector-section");
	const attachmentSection = el("section", "inspector-section");
	const profileSection = el("section", "inspector-section runtime-profile");
	profileSection.setAttribute("aria-label", "Runtime Profile");
	const modelSection = el("section", "inspector-section");
	const laneSection = el("section", "inspector-section");
	const traceSection = el("section", "inspector-section trace");
	traceSection.setAttribute("aria-label", "Mission Trace");
	const traceHeader = el("div", "section-header");
	traceHeader.append(el("h3", "section-title", "Mission Trace"), el("span", "chip", "Live · worker lifetime"));
	const traceNote = el("p", "trace-note", "Recent events of this Session worker · ordered by sequence, not time");
	const traceBody = el("div", "trace-body");
	traceSection.append(traceHeader, traceNote, traceBody);
	const usageSection = el("section", "inspector-section usage");
	usageSection.setAttribute("aria-label", "Usage Activity");
	const usageHeader = el("div", "section-header");
	usageHeader.append(
		el("h3", "section-title", "Usage Activity"),
		el("span", "chip", "Live · durable Session records"),
	);
	const usageNote = el(
		"p",
		"trace-note",
		"Ordered by #sequence, the Session's accounting order shared with its other records · no times",
	);
	const usageBody = el("div", "usage-body");
	usageSection.append(usageHeader, usageNote, usageBody);
	const overviewSection = el("section", "inspector-section overview");
	const accountingSection = el("section", "inspector-section accounting");
	accountingSection.setAttribute("aria-label", "Session Accounting");
	const continuitySection = el("section", "inspector-section continuity");
	continuitySection.setAttribute("aria-label", "Continuity");
	inspectorPanel.append(
		connectionSection,
		attachmentSection,
		profileSection,
		modelSection,
		laneSection,
		traceSection,
		usageSection,
		overviewSection,
		accountingSection,
		continuitySection,
	);

	const detachButton = el("button", "button", "Detach");
	detachButton.type = "button";
	detachButton.addEventListener("click", () => void getController().detach());
	const overviewButton = el("button", "button", "Capture overview");
	overviewButton.type = "button";
	overviewButton.addEventListener("click", () => void getController().refreshOverview());
	const accountingButton = el("button", "button", "Capture");
	accountingButton.type = "button";
	accountingButton.addEventListener("click", () => void getController().captureAccounting());
	const continuityButton = el("button", "button", "Capture");
	continuityButton.type = "button";
	continuityButton.addEventListener("click", () => void getController().captureContinuity());

	const renderStatus = (controller: CockpitController): void => {
		const { presentation } = controller;
		const models = projectModels(presentation.models.value);
		const brand = el("div", "brand");
		brand.append(
			el("span", "brand-mark", "◈"),
			el("span", "brand-name", "Endophasia"),
			el("span", "brand-mode", "Standard"),
		);
		const pills = el("div", "pills");
		pills.append(
			pill(projectConnection(presentation.connection.value)),
			pill(projectAttachment(presentation.attachment.value)),
		);
		if (controller.pendingSelection !== undefined) {
			pills.append(pill({ tone: "pending", glyph: "◌", label: "Requested", detail: controller.pendingSelection }));
		}
		if (models !== undefined) {
			const model = el("span", "meta-pair");
			model.append(el("span", "meta-label", "Configured model"), el("span", "meta-value", models.configuredModel));
			const thinking = el("span", "meta-pair");
			thinking.append(el("span", "meta-label", "Thinking"), el("span", "meta-value", models.thinkingLevel));
			pills.append(model, thinking);
		}
		statusBar.replaceChildren(brand, pills);
	};

	const renderSessions = (controller: CockpitController): void => {
		const { presentation } = controller;
		const rows = projectSessions(
			presentation.sessions.value,
			presentation.attachment.value,
			controller.pendingSelection,
		);
		sessionsEmpty.hidden = rows.length > 0 || presentation.sessions.value === undefined;
		const items = rows.map((row) => {
			const item = el("li");
			const button = el("button", `session-row state-${row.state}`);
			button.type = "button";
			button.setAttribute("aria-pressed", String(row.state === "attached"));
			if (row.state === "attached") button.setAttribute("aria-current", "true");
			const marker = { attached: "●", attaching: "◌", degraded: "△", requested: "◌", available: "○" }[row.state];
			const label = {
				attached: "attached",
				attaching: "attaching",
				degraded: "degraded",
				requested: "requested",
				available: "",
			}[row.state];
			button.append(el("span", "session-marker", marker), el("span", "session-id", row.sessionId));
			const meta = el("span", "session-meta", row.created);
			if (label) meta.append(el("span", "session-state", ` · ${label}`));
			button.append(meta);
			button.addEventListener("click", () => getController().select(row.sessionId));
			item.append(button);
			return item;
		});
		sessionsList.replaceChildren(...items);
	};

	const renderTranscript = (controller: CockpitController): void => {
		const { presentation } = controller;
		const attachment = presentation.attachment.value;
		const snapshot = attachment?.status === "attached" ? presentation.transcript.value?.snapshot : undefined;
		const pinned =
			transcriptScroll.scrollHeight - transcriptScroll.scrollTop - transcriptScroll.clientHeight <=
			PINNED_SCROLL_SLACK;

		if (snapshot === undefined || snapshot === null) {
			transcriptEmpty.hidden = false;
			transcriptEmpty.textContent =
				attachment === undefined || attachment.status === "detached"
					? "Select a Session to observe its main-lane transcript."
					: attachment.status === "degraded"
						? `Attachment to ${attachment.sessionId} is degraded; its Session services are unavailable.`
						: `Attaching ${attachment.sessionId}…`;
			entryList.replaceChildren();
			renderedEntries.clear();
			streamingSlot.replaceChildren();
			operationStrip.replaceChildren();
			operationStrip.hidden = true;
			return;
		}

		transcriptEmpty.textContent = "The main-lane transcript is empty.";

		// Keyed reconciliation: entries are immutable, so an unchanged source object keeps its card.
		const visible = projectVisibleTranscript(snapshot.transcript, projections);
		transcriptEmpty.hidden = visible.length > 0;
		const seen = new Set<string>();
		let index = 0;
		for (const { source: entry, view } of visible) {
			const key = `${view.id}:${index}`;
			seen.add(key);
			let rendered = renderedEntries.get(key);
			if (rendered === undefined || rendered.source !== entry) {
				const element = renderCard(view);
				rendered?.element.replaceWith(element);
				rendered = { source: entry, element };
				renderedEntries.set(key, rendered);
			}
			if (entryList.children[index] !== rendered.element) {
				entryList.insertBefore(rendered.element, entryList.children[index] ?? null);
			}
			index++;
		}
		for (const [key, rendered] of renderedEntries) {
			if (!seen.has(key)) {
				rendered.element.remove();
				renderedEntries.delete(key);
			}
		}

		const operation = snapshot.operation;
		const streaming =
			operation?.streamingMessage === undefined
				? undefined
				: projectMessage(`streaming:${operation.id}`, operation.streamingMessage);
		streamingSlot.replaceChildren(...(streaming === undefined ? [] : [renderCard(streaming, "streaming")]));

		const view = projectOperation(operation, snapshot.lastResult);
		const status = el("span", `pill ${view.idle ? "tone-idle" : "tone-live"}`);
		status.append(el("span", "pill-glyph", view.idle ? "○" : "●"), el("span", "pill-label", view.label));
		const strip: HTMLElement[] = [status];
		for (const meta of view.meta) strip.push(el("span", "chip", meta));
		const queues = projectQueues(snapshot.queues);
		if (queues !== undefined) strip.push(el("span", "chip", queues));
		if (snapshot.faulted) strip.push(el("span", "chip chip-warn", "△ lane faulted"));
		for (const tool of view.tools) {
			const toolElement = el("details", `tool-activity tool-${tool.status}`);
			toolElement.append(
				el("summary", undefined, `Tool · ${tool.toolName} · ${tool.status}`),
				boundedPre(tool.args),
			);
			strip.push(toolElement);
		}
		operationStrip.hidden = false;
		operationStrip.replaceChildren(...strip);

		if (pinned) transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
	};

	const renderInspector = (controller: CockpitController): void => {
		const { presentation } = controller;
		const connection = projectConnection(presentation.connection.value);
		connectionSection.replaceChildren(el("h3", "section-title", "Connection"), pill(connection));

		const attachment = presentation.attachment.value;
		const attachmentList = el("dl", "fields");
		if (controller.pendingSelection !== undefined) {
			attachmentList.append(field("Requested", `${controller.pendingSelection} · awaiting Pi`, "muted"));
		}
		detachButton.disabled = !controller.canDetach;
		attachmentSection.replaceChildren(
			el("h3", "section-title", "Attachment"),
			pill(projectAttachment(attachment)),
			attachmentList,
			detachButton,
		);

		const models = projectModels(presentation.models.value);
		const modelList = el("dl", "fields");
		if (models === undefined) {
			modelList.append(field("Configured model", "not hydrated", "muted"));
		} else {
			modelList.append(
				field("Configured model", models.configuredModel, "mono"),
				field("Thinking level", models.thinkingLevel, "mono"),
				field("Available models", String(models.availableModels), "mono"),
				field("Catalog", models.refresh, "mono"),
			);
		}
		modelSection.replaceChildren(el("h3", "section-title", "Model configuration"), modelList);

		const snapshot = attachment?.status === "attached" ? presentation.transcript.value?.snapshot : undefined;
		if (snapshot === undefined || snapshot === null) {
			laneSection.hidden = true;
		} else {
			laneSection.hidden = false;
			const laneList = el("dl", "fields");
			laneList.append(
				field("Lane", snapshot.lane, "mono"),
				field("Tip", snapshot.tipId ?? "empty", "mono"),
				field("Entries", String(snapshot.transcript.length), "mono"),
				field("Messages", String(snapshot.stats.messageCount), "mono"),
				field("Active tools", String(snapshot.configuration.activeToolNames.length), "mono"),
			);
			laneSection.replaceChildren(el("h3", "section-title", "Main lane"), laneList);
		}

		const capture = controller.overview;
		const header = el("div", "section-header");
		header.append(el("h3", "section-title", "Session Overview"), overviewButton);
		overviewButton.disabled = attachment?.status !== "attached" || capture.status === "capturing";
		overviewButton.textContent = capture.status === "captured" ? "Refresh overview" : "Capture overview";
		const body: HTMLElement[] = [header];
		switch (capture.status) {
			case "none":
				body.push(
					el(
						"p",
						"muted",
						attachment?.status === "attached"
							? "Not captured. Session Overview is an explicit per-lane capture, not live state."
							: "Attach a Session to capture its overview.",
					),
				);
				break;
			case "capturing":
				body.push(el("p", "muted", `Capturing ${capture.sessionId}…`));
				break;
			case "failed":
				body.push(el("p", "block-error", `Capture failed: ${capture.message}`));
				break;
			case "captured": {
				const view = projectSessionOverview(capture.overview, capture.capturedAt);
				const summary = el("dl", "fields");
				summary.append(
					field("Received", view.capturedAt, "mono"),
					field("Consistency", view.consistency, "mono"),
					field("Counts", view.counts, "mono"),
				);
				const lanes = el("ul", "lane-list");
				for (const lane of view.lanes) {
					const item = el("li", "lane");
					const laneHeader = el("div", "lane-header");
					laneHeader.append(el("span", "lane-name", lane.name), el("span", "chip", lane.operation ?? "idle"));
					const laneFields = el("dl", "fields");
					laneFields.append(field("Tip", lane.tipId, "mono"));
					if (lane.startedAt !== undefined) laneFields.append(field("Started", lane.startedAt, "mono"));
					if (lane.capturedModel !== undefined)
						laneFields.append(field("Captured model", lane.capturedModel, "mono"));
					item.append(laneHeader, laneFields);
					lanes.append(item);
				}
				body.push(summary, lanes);
				break;
			}
		}
		overviewSection.replaceChildren(...body);
		renderAccounting(controller);
	};

	const renderAccounting = (controller: CockpitController): void => {
		const capture = controller.accounting;
		const header = el("div", "section-header");
		header.append(el("h3", "section-title", "Session Accounting"), accountingButton);
		accountingButton.disabled = !controller.canCaptureAccounting;
		accountingButton.textContent = capture.status === "captured" ? "Refresh" : "Capture";
		const body: HTMLElement[] = [header];
		switch (capture.status) {
			case "none":
				body.push(
					el(
						"p",
						"muted",
						controller.presentation.attachment.value?.status === "attached"
							? "Not captured. Session Accounting is an explicit capture, not live state."
							: "Attach a Session to capture its accounting.",
					),
				);
				break;
			case "capturing":
				body.push(el("p", "muted", `Capturing ${capture.sessionId}…`));
				break;
			case "failed":
				body.push(el("p", "block-error", `Capture failed: ${capture.message}`));
				break;
			case "captured": {
				const view = projectRuntimeMetrics(capture.metrics, capture.capturedAt);
				const fields = el("dl", "fields");
				fields.append(field("Received", view.capturedAt, "mono"));
				for (const row of view.rows) fields.append(field(row.label, row.value, "mono"));
				body.push(
					fields,
					el(
						"p",
						"trace-note",
						"Cumulative session accounting · explicit capture · not current context occupancy",
					),
					el("p", "trace-note", "Pi-maintained cumulative accounting · not a provider invoice"),
				);
				break;
			}
		}
		accountingSection.replaceChildren(...body);
	};

	const continuityEntries = (title: string, view: ContinuityEntriesView): HTMLElement => {
		const details = el("details", "continuity-entries");
		details.append(el("summary", undefined, `${title} · ${view.total.toLocaleString("en-US")}`));
		if (view.window !== undefined) details.append(el("p", "trace-window", view.window));
		if (view.rows.length === 0) {
			details.append(el("p", "muted", "No entries."));
			return details;
		}
		const list = el("ol", "continuity-list");
		for (const row of view.rows) {
			const item = el("li", "continuity-row");
			item.title = row.id;
			const head = el("div", "continuity-row-head");
			head.append(
				el("span", "trace-sequence", row.sequence),
				el("span", "continuity-label", row.label),
				el("span", "trace-subject", row.id),
			);
			item.append(head);
			if (row.meta.length > 0) {
				const meta = el("div", "continuity-meta");
				for (const part of row.meta) meta.append(el("span", "chip", part));
				item.append(meta);
			}
			list.append(item);
		}
		details.append(list);
		return details;
	};

	const renderContinuity = (controller: CockpitController): void => {
		const capture = controller.continuity;
		const header = el("div", "section-header");
		header.append(el("h3", "section-title", "Continuity"), continuityButton);
		continuityButton.disabled = !controller.canCaptureContinuity;
		continuityButton.textContent = capture.status === "captured" ? "Refresh" : "Capture";
		const body: HTMLElement[] = [header];
		switch (capture.status) {
			case "none":
				body.push(
					el(
						"p",
						"muted",
						controller.presentation.attachment.value?.status === "attached"
							? "Not captured. Continuity is an explicit main-lane capture, not live state."
							: "Attach a Session to capture its main-lane Continuity.",
					),
				);
				break;
			case "capturing":
				body.push(el("p", "muted", `Capturing ${capture.sessionId}…`));
				break;
			case "failed":
				body.push(el("p", "block-error", `Capture failed: ${capture.message}`));
				break;
			case "captured": {
				const view = projectContinuity(capture.snapshot, capture.capturedAt);
				const fields = el("dl", "fields");
				fields.append(field("Session", capture.sessionId, "mono"), field("Received", view.capturedAt, "mono"));
				for (const row of view.fields) fields.append(field(row.label, row.value, "mono"));
				const compaction = el("dl", "fields");
				if (view.compaction === undefined) {
					compaction.append(field("Compaction boundary", "none", "mono"));
				} else {
					for (const row of view.compaction)
						compaction.append(field(`Compaction ${row.label.toLowerCase()}`, row.value, "mono"));
				}
				body.push(
					fields,
					compaction,
					el(
						"p",
						"trace-note",
						"Durable ancestry at one captured tip · the context window is Pi's compaction-bounded source entries, not the provider-visible prompt",
					),
					el("p", "trace-note", "Structure only · message, summary and custom contents are not captured"),
					continuityEntries("Context window", view.contextWindow),
					continuityEntries("Active path", view.activePath),
				);
				break;
			}
		}
		continuitySection.replaceChildren(...body);
	};

	const renderProfile = (controller: CockpitController): void => {
		const visibility = controller.runtimeProfile;
		const header = el("div", "section-header");
		const scopeChip = el("span", "chip", "Live");
		header.append(el("h3", "section-title", "Runtime Profile"), scopeChip);
		if (visibility.status === "hidden") {
			const message = {
				detached: "Attach a Session to see its worker's Runtime Profile.",
				switching: "Hidden while the observed Session changes.",
				attaching: "Hidden until the Session is attached.",
				unhydrated: "No Runtime Profile hydrated for this attachment.",
			}[visibility.reason];
			profileSection.replaceChildren(header, el("p", "muted", message));
			return;
		}
		const view = projectRuntimeProfile(visibility.profile);
		// The lifetime is claimed only when the profile states the exact v0 scope.
		scopeChip.textContent = view.workerLifetime ? "Live · worker lifetime" : "Live · unrecognized scope";
		const fields = el("dl", "fields");
		fields.append(
			field("Runtime family", view.runtimeFamily, "mono"),
			field("Adapter profile", view.adapterProfileId, "mono"),
			field("Scope", view.scope),
			field("Capabilities", view.advertised),
		);
		const body: HTMLElement[] = [header];
		if (visibility.attachment === "degraded") {
			body.push(
				el(
					"p",
					"block-error",
					"△ Attachment degraded · this profile is the worker's claim, not evidence that its services hydrated",
				),
			);
		}
		if (view.schemaNote !== undefined) body.push(el("p", "block-error", view.schemaNote));
		body.push(
			fields,
			el(
				"p",
				"trace-note",
				"Advertised by the worker's Endophasia composition · not a runtime feature list or a conformance result",
			),
		);
		for (const group of view.groups) {
			const section = el("div", "capability-group");
			section.append(el("div", "capability-group-title", group.title), el("p", "trace-note", group.note));
			const list = el("ul", "capability-list");
			for (const row of group.rows) {
				const item = el("li", `capability-row ${row.status === "advertised" ? "advertised" : "not-advertised"}`);
				item.title = row.id;
				item.append(
					el("span", "capability-glyph", row.status === "advertised" ? "●" : "○"),
					el("span", "capability-label", row.label),
					el("span", "capability-status", row.status),
				);
				list.append(item);
			}
			section.append(list);
			body.push(section);
		}
		if (view.unrecognized.length > 0) {
			const section = el("div", "capability-group");
			section.append(
				el("div", "capability-group-title", "Other advertised identifiers"),
				el("p", "trace-note", "Not part of the Endophasia v0 catalogue · shown as sent, with no meaning assigned"),
			);
			const list = el("ul", "capability-list");
			for (const id of view.unrecognized) list.append(el("li", "capability-row unrecognized mono", id));
			section.append(list);
			if (view.unrecognizedWindow !== undefined) section.append(el("p", "trace-window", view.unrecognizedWindow));
			body.push(section);
		}
		profileSection.replaceChildren(...body);
	};

	const renderTrace = (controller: CockpitController): void => {
		const trace = controller.missionTrace;
		if (trace.status === "hidden") {
			const message = {
				detached: "Attach a Session to observe its Mission Trace.",
				switching: "Hidden while the observed Session changes.",
				attaching: "Hidden until the Session is attached.",
				degraded: "Unavailable: the Session attachment is degraded.",
				hydrating: "Waiting for the Mission Trace to hydrate.",
			}[trace.reason];
			traceBody.replaceChildren(el("p", "muted", message));
			return;
		}
		const view = projectMissionTrace(trace.observation);
		if (view.total === 0) {
			traceBody.replaceChildren(el("p", "muted", "No lifecycle events observed yet."));
			return;
		}
		const list = el("ol", "trace-list");
		for (const row of view.rows) {
			const item = el("li", `trace-row family-${row.family} depth-${row.depth} tone-${row.tone}`);
			if (row.title !== "") item.title = row.title;
			const head = el("div", "trace-row-head");
			head.append(
				el("span", "trace-sequence", row.sequence),
				el("span", "trace-node"),
				el("span", "trace-label", row.label),
				el("span", "trace-subject", row.subject),
			);
			item.append(head);
			if (row.meta.length > 0) {
				const meta = el("div", "trace-meta");
				for (const part of row.meta) meta.append(el("span", `chip${part === "error" ? " chip-warn" : ""}`, part));
				item.append(meta);
			}
			list.append(item);
		}
		const parts: HTMLElement[] = [];
		if (view.truncated !== undefined) parts.push(el("p", "trace-window", view.truncated));
		if (view.window !== undefined) parts.push(el("p", "trace-window", view.window));
		parts.push(list);
		traceBody.replaceChildren(...parts);
	};

	const renderUsage = (controller: CockpitController): void => {
		const usage = controller.usage;
		if (usage.status === "hidden") {
			const message = {
				detached: "Attach a Session to observe its usage records.",
				switching: "Hidden while the observed Session changes.",
				attaching: "Hidden until the Session is attached.",
				degraded: "Unavailable: the Session attachment is degraded.",
				hydrating: "Waiting for the usage records to hydrate.",
			}[usage.reason];
			usageBody.replaceChildren(el("p", "muted", message));
			return;
		}
		const view = projectUsage(usage.observation);
		const parts: HTMLElement[] = [];
		if (view.rows.length === 0) {
			parts.push(el("p", "muted", "No usage records yet."));
		} else {
			const list = el("ol", "usage-list");
			for (const row of view.rows) {
				const item = el("li", `usage-row${row.label === "adjustment" ? " adjustment" : ""}`);
				const head = el("div", "usage-row-head");
				head.append(el("span", "trace-sequence", row.sequence), el("span", "usage-label", row.label));
				item.append(
					head,
					el("div", "usage-totals mono", row.totals),
					el("div", "usage-detail mono", `${row.cost} · ${row.detail}`),
				);
				list.append(item);
			}
			parts.push(list);
		}
		if (view.window !== undefined) parts.push(el("p", "trace-window", view.window));
		if (view.earlier !== undefined) parts.push(el("p", "trace-window", view.earlier));
		usageBody.replaceChildren(...parts);
	};

	const renderDiagnostics = (controller: CockpitController): void => {
		const latest = controller.diagnostics[0];
		const diagnostic = el("div", "diagnostic");
		diagnostic.setAttribute("role", "status");
		if (latest !== undefined) {
			diagnostic.append(
				el("span", "diagnostic-glyph", "△"),
				el("span", "mono", formatClock(latest.at)),
				el("span", "diagnostic-message", latest.message),
			);
			if (controller.diagnostics.length > 1) {
				diagnostic.append(el("span", "chip", `${controller.diagnostics.length} recent`));
			}
		}
		footer.replaceChildren(diagnostic, el("span", "footer-note", "Standard Cockpit v0 · read-only observation"));
	};

	return {
		render(regions) {
			const controller = getController();
			if (regions.has("status")) renderStatus(controller);
			if (regions.has("profile")) renderProfile(controller);
			if (regions.has("sessions")) renderSessions(controller);
			if (regions.has("transcript")) renderTranscript(controller);
			if (regions.has("inspector")) renderInspector(controller);
			if (regions.has("trace")) renderTrace(controller);
			if (regions.has("usage")) renderUsage(controller);
			if (regions.has("continuity")) renderContinuity(controller);
			if (regions.has("diagnostics")) renderDiagnostics(controller);
		},
	};
}

/** Replace root with a bounded, text-only screen for loading or startup failure. */
export function renderNotice(root: HTMLElement, title: string, message: string, tone: "pending" | "warn"): void {
	const notice = el("div", `notice tone-${tone}`);
	notice.setAttribute("role", tone === "warn" ? "alert" : "status");
	notice.append(el("span", "brand-mark", "◈"), el("h1", "notice-title", title), el("p", "notice-message", message));
	if (tone === "warn") {
		const reload = el("button", "button", "Reload page");
		reload.type = "button";
		reload.addEventListener("click", () => location.reload());
		notice.append(reload);
	}
	root.replaceChildren(notice);
}
