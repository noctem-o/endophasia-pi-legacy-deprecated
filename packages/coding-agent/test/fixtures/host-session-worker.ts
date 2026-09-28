import { appendFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runCodingAgentSessionWorker } from "../../src/experimental/session-worker.ts";
import { createKeyedProbeFacet } from "./keyed-service.ts";

/**
 * Appends one JSON line per host-facet construction, describing the runtime the host received, and per harness close.
 */
export const HOST_WORKER_LOG_ENV = "PI_TEST_HOST_WORKER_LOG";
/** When this file exists, the next host-facet construction deletes it and throws. */
export const HOST_WORKER_FAIL_ONCE_ENV = "PI_TEST_HOST_WORKER_FAIL_ONCE";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Host Session worker requires a session-worker invocation");
	const log = (entry: object): void => {
		const path = process.env[HOST_WORKER_LOG_ENV];
		if (path !== undefined) appendFileSync(path, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
	};
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		async createHostFacets(runtime) {
			const { harness, usageReader } = runtime;
			log({
				event: "host-facets",
				keys: Object.keys(runtime),
				usageReader: {
					keys: Object.keys(usageReader),
					frozen: Object.isFrozen(usageReader),
					rows: (await usageReader.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).length,
				},
			});
			const close = harness.close.bind(harness);
			harness.close = async (context) => {
				log({ event: "harness-closed" });
				await close(context);
			};
			const failOnce = process.env[HOST_WORKER_FAIL_ONCE_ENV];
			if (failOnce !== undefined && existsSync(failOnce)) {
				rmSync(failOnce);
				throw new Error("Host facet construction failed");
			}
			return [createKeyedProbeFacet()];
		},
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
