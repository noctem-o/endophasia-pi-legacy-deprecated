import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { type RunningServer, startServer } from "@earendil-works/pi-coding-agent/experimental/server";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type EndophasiaPresentationClientV0, openEndophasiaPresentationClientV0 } from "../presentation/client.ts";
import { startEndophasiaServer } from "../runtime/server.ts";

const directories: string[] = [];
const servers: RunningServer[] = [];
const presentations: EndophasiaPresentationClientV0[] = [];
const workerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

beforeEach(async () => {
	// The standard worker resolves its configured model offline from a local API-key credential.
	const agentDir = await temporaryDirectory("endophasia-presentation-agent-");
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }), {
		mode: 0o600,
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OFFLINE", "1");
	await createSessions(join(agentDir, "experimental", "sessions"), ["observed", "other"]);
});

afterEach(async () => {
	for (const presentation of presentations.splice(0)) await presentation.dispose();
	for (const server of servers.splice(0)) await server.close();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join("/tmp", prefix));
	directories.push(directory);
	return directory;
}

async function createSessions(sessionsRoot: string, ids: readonly string[]): Promise<void> {
	await mkdir(sessionsRoot, { recursive: true });
	const fileSystem = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot });
	try {
		for (const id of ids) {
			await (await repo.create({ id, cwd: process.cwd() }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		}
	} finally {
		await repo.close(BACKGROUND_CONTEXT);
		await fileSystem.cleanup(BACKGROUND_CONTEXT);
	}
}

async function open(server: RunningServer, errors: Error[] = []): Promise<EndophasiaPresentationClientV0> {
	const presentation = await openEndophasiaPresentationClientV0({
		serverId: server.serverId,
		transportFactory: createUnixTransportFactory({ path: server.socketPath }),
		onError: (error) => errors.push(error),
	});
	presentations.push(presentation);
	return presentation;
}

describe("Endophasia Presentation Client v0", () => {
	it("observes a real Endophasia Session over the Pi protocol", async () => {
		const server = await startEndophasiaServer({
			...workerModel,
			directory: await temporaryDirectory("endophasia-presentation-server-"),
		});
		servers.push(server);
		const errors: Error[] = [];
		const presentation = await open(server, errors);

		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.attachment.value).toEqual({ status: "detached" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId).sort()).toEqual([
			"observed",
			"other",
		]);

		const observe = async (sessionId: string): Promise<void> => {
			await presentation.attach(sessionId, BACKGROUND_CONTEXT);
			expect(presentation.attachment.value).toEqual({ status: "attached", sessionId });
			expect(presentation.transcript.value?.snapshot).toMatchObject({
				lane: "main",
				operation: null,
				configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
			});
			expect(presentation.models.value?.configuration.model).toEqual({
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			});
			const overview = await presentation.sessionOverview(BACKGROUND_CONTEXT);
			expect(overview).toMatchObject({
				schemaVersion: "session-overview.v0",
				consistency: "per-lane",
				lanes: [{ name: "main", operation: null }],
				counts: { lanes: 1, activeOperations: 0, abortingOperations: 0 },
			});
		};
		await observe("observed");

		await presentation.detach(BACKGROUND_CONTEXT);
		expect(presentation.attachment.value).toEqual({ status: "detached" });
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();

		// Later attachment generations rebind every Session service, including the Inspector.
		await observe("other");
		await presentation.detach(BACKGROUND_CONTEXT);
		// Re-attach "observed" once its idle worker has stopped: a re-attach that races Pi's idle-worker shutdown
		// currently fails with an internal server error, independent of this client.
		await expect.poll(() => server.workerPids.size).toBe(0);
		await observe("observed");
		expect(errors).toEqual([]);

		await presentation.dispose();
		await presentation.dispose();
		await expect(Promise.resolve().then(() => presentation.sessionOverview(BACKGROUND_CONTEXT))).rejects.toThrow();
		// The server releases the disposed client's attachment, so the idle worker stops.
		await expect.poll(() => server.workerPids.size).toBe(0);
	});

	it("exposes no agent control, model mutation or Session management", () => {
		expectTypeOf<keyof EndophasiaPresentationClientV0>().toEqualTypeOf<
			| "connection"
			| "attachment"
			| "sessions"
			| "transcript"
			| "models"
			| "attach"
			| "detach"
			| "sessionOverview"
			| "dispose"
		>();
		expectTypeOf<keyof EndophasiaPresentationClientV0["models"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<keyof EndophasiaPresentationClientV0["transcript"]>().toEqualTypeOf<"value" | "subscribe">();
		expectTypeOf<keyof EndophasiaPresentationClientV0["sessions"]>().toEqualTypeOf<"value" | "subscribe">();
	});

	it("reports a degraded attachment instead of an Endophasia view on a plain Pi server", async () => {
		const server = await startServer({ ...workerModel, directory: await temporaryDirectory("endophasia-plain-") });
		servers.push(server);
		const presentation = await open(server);
		expect(presentation.connection.value).toMatchObject({ status: "connected" });
		expect(presentation.sessions.value?.sessions.map((session) => session.sessionId)).toContain("observed");

		await expect(presentation.attach("observed", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Remote service endophasia.inspector.v0 is not allowlisted",
		);
		expect(presentation.attachment.value).toEqual({ status: "degraded", sessionId: "observed" });
	});

	it("loads in plain Node with coding-agent's source resolver preloaded, without Vitest aliases", async () => {
		const resolver = new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url);
		const client = new URL("../presentation/client.ts", import.meta.url);
		const script = `console.log(typeof (await import(${JSON.stringify(client.href)})).openEndophasiaPresentationClientV0);`;
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--import",
			resolver.href,
			"--input-type=module",
			"--eval",
			script,
		]);
		expect(stdout.trim()).toBe("function");
	});
});
