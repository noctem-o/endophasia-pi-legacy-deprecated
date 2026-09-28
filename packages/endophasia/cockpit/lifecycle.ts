// Page lifecycle for Standard Cockpit v0. Leaving the page disposes the controller and Presentation Client. A page
// restored from the back-forward cache is the same, already disposed document and does not rerun the entry module,
// so it reloads: a fresh bootstrap and a fresh Presentation Client. This is not a reconnect policy; nothing retries.

export type PageLifecycleEvent = "pagehide" | "pageshow";

/** Subscribes to a page lifecycle event; persisted is PageTransitionEvent.persisted. */
export type ListenPageLifecycle = (type: PageLifecycleEvent, listener: (persisted: boolean) => void) => void;

export interface PageLifecycleActions {
	/** Release the active cockpit, if any. Called on every pagehide. */
	dispose(): void;
	/** Start over from a fresh document load. */
	reload(): void;
}

export function bindPageLifecycle(listen: ListenPageLifecycle, actions: PageLifecycleActions): void {
	listen("pagehide", () => actions.dispose());
	listen("pageshow", (persisted) => {
		if (persisted) actions.reload();
	});
}
