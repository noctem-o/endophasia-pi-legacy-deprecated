// Opt-in, research-only ACP process probe using Prime's actual --mode acp entrypoint.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpRequestError, ResearchAcpClient } from "./acp-client.ts";
import {
	type AcpScenarioEvidence,
	acpObject,
	acpSessionId,
	decodeAcpInitialize,
	decodeAcpPrompt,
	decodeAcpUpdate,
} from "./acp-evidence.ts";
import { createPrimeEnvironmentV0, PROBE_MODEL, type PrimeBinaryV0 } from "./environment.ts";
import type { PrimeProvenanceV0 } from "./evidence.ts";
import { SENTINELS, startFakeProviderV0 } from "./fake-provider.ts";
import { readPrimeSessionFileV0 } from "./probe.ts";

export const ACP_SCENARIOS = [
	{ name: "simple", markers: ["simple"] },
	{ name: "tool-run", markers: ["tool-run"] },
	{ name: "tool-error", markers: ["tool-error"] },
	{ name: "provider-failure", markers: ["provider-failure"] },
	{ name: "cancel-stream", markers: ["abort-stream"] },
	{ name: "cancel-tool", markers: ["abort-tool"] },
	{ name: "length-stop", markers: ["length"] },
	{ name: "reasoning-usage", markers: ["reasoning"] },
	{ name: "token-limit", markers: ["simple"], args: ["--autonomous-max-tokens", "1"] },
	{ name: "turn-limit", markers: ["simple"], args: ["--autonomous-max-turns", "1"] },
	{ name: "compaction", markers: ["multi-a", "multi-b"] },
	{
		name: "gate-failure",
		markers: ["simple"],
		args: ["--autonomous-gate", "false", "--autonomous-gate-retries", "1", "--autonomous-max-turns", "1"],
	},
	{ name: "unsupported-requests", markers: [] },
	{ name: "multi-prompt", markers: ["multi-a", "multi-b"] },
	{ name: "close-recreate", markers: ["multi-a", "multi-b"] },
] as const;

export async function runAcpProbe(
	binary: PrimeBinaryV0,
	provenance: PrimeProvenanceV0,
	log: (name: string) => void,
): Promise<AcpScenarioEvidence[]> {
	const evidence: AcpScenarioEvidence[] = [];
	for (const scenario of ACP_SCENARIOS) {
		log(`ACP ${scenario.name}`);
		const fake = await startFakeProviderV0({ markers: scenario.markers, model: PROBE_MODEL });
		const environment = createPrimeEnvironmentV0({ providerBaseUrl: fake.baseUrl });
		const settings = join(environment.root, "agent", "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), retry: { enabled: false } }),
		);
		const run: AcpScenarioEvidence = {
			schemaVersion: "prime-acp-evidence.v0",
			provenance: { ...provenance, mode: "acp", scenario: scenario.name },
			updates: [],
			prompts: [],
			commands: [],
			sessionIds: [],
			cancelAfter: [],
			providerRequests: 0,
			summaryRequests: 0,
			files: [],
			protocolErrors: [],
			failures: [],
		};
		let sessionId: string | undefined;
		let cancelKind: string | undefined;
		let cancellation: Promise<void> | undefined;
		const baseArgs = [...environment.baseArgs];
		baseArgs[baseArgs.indexOf("rpc")] = "acp";
		const client = new ResearchAcpClient({
			command: binary.command,
			args: [...binary.leadingArgs, ...baseArgs, ...("args" in scenario ? scenario.args : [])],
			cwd: environment.cwd,
			env: environment.env,
			onUpdate(value) {
				const update = decodeAcpUpdate(value);
				run.updates.push(update);
				if (cancelKind === update.kind && sessionId !== undefined) {
					cancelKind = undefined;
					const triggerIndex = run.updates.length - 1;
					const cancelledSession = sessionId;
					run.cancelAfter.push(triggerIndex);
					cancellation = client.notify("session/cancel", { sessionId }).then(
						() => {
							run.commands.push({
								method: "session/cancel",
								success: true,
								sessionId: cancelledSession,
								triggerIndex,
							});
						},
						() => {
							run.failures.push("ACP cancellation local write failed");
						},
					);
				}
			},
		});
		const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
			try {
				const result = await client.request(method, params);
				run.commands.push({ method, success: true });
				return result;
			} catch (error) {
				run.commands.push({
					method,
					success: false,
					...(error instanceof AcpRequestError ? { errorCode: error.code } : {}),
				});
				throw error;
			}
		};
		const open = async (): Promise<void> => {
			const result = acpObject(
				await request("session/new", { cwd: environment.cwd, mcpServers: [] }),
				"session/new",
			);
			sessionId = acpSessionId(result.sessionId);
			run.sessionIds.push(sessionId);
		};
		const prompt = async (marker: string, literal = false): Promise<void> => {
			const ordinal = run.prompts.length + 1;
			try {
				run.prompts.push(
					decodeAcpPrompt(
						await request("session/prompt", {
							sessionId,
							prompt: [{ type: "text", text: literal ? marker : `SCENARIO:${marker} ${SENTINELS.prompt}` }],
						}),
						ordinal,
					),
				);
			} catch (error) {
				if (!(error instanceof AcpRequestError)) throw error;
				run.prompts.push({ ordinal, response: "error", errorCode: error.code });
			}
		};
		try {
			run.initialize = decodeAcpInitialize(
				await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
					clientInfo: { name: "endophasia-research", version: provenance.probeVersion },
				}),
			);
			await open();
			if (scenario.name === "unsupported-requests") {
				for (const [method, params] of [
					["session/new", { cwd: environment.cwd, mcpServers: [] }],
					["session/load", { sessionId, cwd: environment.cwd, mcpServers: [] }],
					["session/prompt", { sessionId: "00000000-0000-0000-0000-000000000000", prompt: [] }],
				] as const) {
					try {
						await request(method, params);
					} catch (error) {
						if (!(error instanceof AcpRequestError)) throw error;
					}
				}
			}
			if (scenario.name === "cancel-stream") cancelKind = "agent_message_chunk";
			if (scenario.name === "cancel-tool") cancelKind = "tool_call";
			for (const marker of scenario.markers) {
				await prompt(marker);
				await cancellation;
				if (scenario.name === "close-recreate" && marker === "multi-a") {
					await request("session/close", { sessionId });
					await open();
				}
			}
			if (scenario.name === "compaction") {
				fake.allowSummaries(true);
				try {
					await prompt("/compact", true);
				} finally {
					fake.allowSummaries(false);
				}
			}
			await request("session/close", { sessionId });
		} catch {
			run.failures.push("ACP scenario execution failed");
		} finally {
			await cancellation;
			const exit = await client.close();
			if (exit.code !== 0 || exit.signal !== null || exit.spawnFailed)
				run.failures.push("ACP abnormal process exit");
			run.protocolErrors.push(...client.protocolErrors);
			try {
				for (const name of readdirSync(environment.sessionDir)
					.filter((name) => name.endsWith(".jsonl"))
					.sort())
					run.files.push(readPrimeSessionFileV0(join(environment.sessionDir, name), environment.sessionDir));
			} catch {
				run.failures.push("ACP durable file decode failed");
			}
			environment.dispose(binary);
			await fake.close();
		}
		run.providerRequests = fake.requests.length;
		run.summaryRequests = fake.requests.filter((request) => request.kind === "summary").length;
		if (fake.requests.some((request) => request.kind === "unexpected" || request.kind === "malformed"))
			run.failures.push("ACP unexpected provider request");
		evidence.push(run);
	}
	return evidence;
}
