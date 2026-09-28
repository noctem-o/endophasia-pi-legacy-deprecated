// Research-only (Prime Runtime Conformance v0). An isolated, disposable environment for one live Prime run: its own
// HOME, TMPDIR (which also holds Prime's daemon socket), XDG directories, agent directory, session directory, working
// directory and model configuration. The user's ~/.prime state is never read or written.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROBE_PROVIDER = "probe-local";
export const PROBE_MODEL = "probe-model";

/**
 * Model prices per million tokens chosen so every cost is an exact binary fraction of the token count:
 * cost = tokens × 1, × 2, × 0.5 and × 0.25.
 */
export const PROBE_MODEL_COST = {
	input: 1_000_000,
	output: 2_000_000,
	cacheRead: 500_000,
	cacheWrite: 250_000,
} as const;

/** A harmless extension tool, so the probe exercises tool calls without Prime's Python kernel or any shell. */
const PROBE_TOOL_EXTENSION = `import { Type } from "typebox";

export default function (pi) {
	pi.registerTool({
		name: "probe_tool",
		label: "Probe tool",
		description: "Deterministic conformance probe tool.",
		parameters: Type.Object({ mode: Type.String(), note: Type.String() }),
		async execute(_toolCallId, params, signal) {
			if (params.mode === "fail") throw new Error("ERROR_DETAIL_SENTINEL tool failed");
			if (params.mode === "hang") {
				await new Promise((resolve) => {
					if (signal?.aborted) return resolve(undefined);
					signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				});
				throw new Error("ERROR_DETAIL_SENTINEL tool aborted");
			}
			return { content: [{ type: "text", text: "TOOL_RESULT_SENTINEL ok" }], details: { note: "TOOL_RESULT_SENTINEL" } };
		},
	});
}
`;

export interface PrimeBinaryV0 {
	/** The executable to spawn, and any leading arguments (for a source checkout's launcher). */
	readonly command: string;
	readonly leadingArgs: readonly string[];
	readonly description: string;
	/** The source checkout the command runs from, when it was selected through PRIME_AGENT_ROOT. */
	readonly checkout?: string;
}

/** Resolve the Prime executable: PRIME_AGENT_BIN, else PRIME_AGENT_ROOT's documented source launcher. */
export function resolvePrimeBinaryV0(env: NodeJS.ProcessEnv): PrimeBinaryV0 | undefined {
	// Prime is spawned from a disposable cwd, so a relative path is resolved against the invocation directory now.
	// A bare command name (no "/") is left to PATH.
	if (env.PRIME_AGENT_BIN !== undefined && env.PRIME_AGENT_BIN.length > 0) {
		const command = env.PRIME_AGENT_BIN.includes("/") ? resolve(env.PRIME_AGENT_BIN) : env.PRIME_AGENT_BIN;
		return { command, leadingArgs: [], description: command };
	}
	if (env.PRIME_AGENT_ROOT !== undefined && env.PRIME_AGENT_ROOT.length > 0) {
		const checkout = resolve(env.PRIME_AGENT_ROOT);
		const launcher = join(checkout, "prime-agent.sh");
		return { command: launcher, leadingArgs: [], description: launcher, checkout };
	}
	return undefined;
}

export interface PrimeEnvironmentV0 {
	readonly root: string;
	readonly cwd: string;
	readonly sessionDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** Arguments that select the fake model, the probe tool and the isolated session directory. */
	readonly baseArgs: readonly string[];
	/** Stop any Prime daemon this environment started, then remove it unless retained. */
	dispose(binary: PrimeBinaryV0): void;
}

export function createPrimeEnvironmentV0(options: { providerBaseUrl: string; retain?: boolean }): PrimeEnvironmentV0 {
	const root = mkdtempSync(join(tmpdir(), "prime-conformance-"));
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	const tmp = join(root, "tmp");
	for (const directory of [home, agentDir, sessionDir, cwd, tmp]) mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROBE_PROVIDER]: {
					baseUrl: options.providerBaseUrl,
					api: "openai-completions",
					apiKey: "probe-unused",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [
						{
							id: PROBE_MODEL,
							name: "Probe Model",
							reasoning: false,
							input: ["text"],
							contextWindow: 100_000,
							maxTokens: 4_096,
							cost: PROBE_MODEL_COST,
						},
					],
				},
			},
		}),
	);
	// A tiny recent-token budget lets a manual compaction summarize even this short probe conversation.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1 } }),
	);
	const extensionPath = join(root, "probe-tool.ts");
	writeFileSync(extensionPath, PROBE_TOOL_EXTENSION);
	// A minimal environment: no inherited provider keys, no user HOME, no shared daemon socket directory.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: tmp,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PRIME_AGENT_SESSION_DIR: sessionDir,
		// Offline: no version check, model-catalog fetch or tool download; no telemetry.
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PRIME_AGENT_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
		NO_COLOR: "1",
	};
	const baseArgs = [
		"--mode",
		"rpc",
		"--provider",
		PROBE_PROVIDER,
		"--model",
		PROBE_MODEL,
		"--session-dir",
		sessionDir,
		"--no-extensions",
		"--no-skills",
		"-e",
		extensionPath,
		"--tools",
		"probe_tool",
	];
	return {
		root,
		cwd,
		sessionDir,
		env,
		baseArgs,
		dispose(binary) {
			spawnSync(binary.command, [...binary.leadingArgs, "shutdown", "--force"], {
				cwd,
				env,
				timeout: 30_000,
				stdio: "ignore",
			});
			if (options.retain !== true) rmSync(root, { recursive: true, force: true });
		},
	};
}
