import { describe, expect, it } from "vitest";
import { bindPageLifecycle, type PageLifecycleEvent } from "../cockpit/lifecycle.ts";

function page() {
	const listeners = new Map<PageLifecycleEvent, ((persisted: boolean) => void)[]>();
	const calls: string[] = [];
	bindPageLifecycle((type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]), {
		dispose: () => calls.push("dispose"),
		reload: () => calls.push("reload"),
	});
	const fire = (type: PageLifecycleEvent, persisted: boolean): void => {
		for (const listener of listeners.get(type) ?? []) listener(persisted);
	};
	return { calls, fire };
}

describe("Standard Cockpit page lifecycle", () => {
	it("disposes on pagehide and reloads a page restored from the back-forward cache", () => {
		const { calls, fire } = page();
		fire("pageshow", false);
		expect(calls).toEqual([]);

		fire("pagehide", true);
		expect(calls).toEqual(["dispose"]);
		fire("pageshow", true);
		expect(calls).toEqual(["dispose", "reload"]);
	});

	it("disposes on a final pagehide without reloading or retrying", () => {
		const { calls, fire } = page();
		fire("pagehide", false);
		expect(calls).toEqual(["dispose"]);
	});
});
