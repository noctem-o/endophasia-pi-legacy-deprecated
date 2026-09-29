// Prime RPC Runtime Ingress v0: which Prime is running. This is runtime identity, not conformance certification: it
// records what can be known (the reported version, how Prime is installed, a source checkout's commit and tree state)
// and claims nothing more. A Prime semantic adapter decides whether an identity belongs to a profile it supports.
import { execFile } from "node:child_process";
import { isAbsolute, join, resolve, win32 } from "node:path";

/** How Prime is started: a standalone executable, or a source checkout's documented launcher. */
export type PrimeInstallationV0 =
	| { readonly mode: "binary"; readonly command: string; readonly leadingArgs: readonly string[] }
	| {
			readonly mode: "source-checkout";
			/** The checkout root (PRIME_AGENT_ROOT). */
			readonly root: string;
			readonly command: string;
			readonly leadingArgs: readonly string[];
	  };

export interface PrimeRuntimeIdentityV0 {
	/** The version `--version` reported: a semver string, never a path. */
	readonly version: string;
	readonly installation: PrimeInstallationV0;
	/**
	 * Source provenance, only for a source checkout. A standalone binary has none: its source commit is not known, and
	 * is never claimed. `tree` is "unknown" (and `commit` absent) when git could not be read.
	 */
	readonly source?: { readonly commit?: string; readonly tree: "clean" | "dirty" | "unknown" };
}

/**
 * Resolve the Prime installation from PRIME_AGENT_BIN (an executable) or else PRIME_AGENT_ROOT (a source checkout).
 * A path-like value is resolved against `cwd`; a bare command name is left to PATH. Undefined when neither is set.
 */
export function resolvePrimeInstallationV0(
	settings: { readonly PRIME_AGENT_BIN?: string; readonly PRIME_AGENT_ROOT?: string },
	cwd: string,
): PrimeInstallationV0 | undefined {
	const bin = settings.PRIME_AGENT_BIN;
	if (bin !== undefined && bin.length > 0) {
		const command = isAbsolute(bin) || win32.isAbsolute(bin) || /[\\/]/.test(bin) ? resolve(cwd, bin) : bin;
		return { mode: "binary", command, leadingArgs: [] };
	}
	const root = settings.PRIME_AGENT_ROOT;
	if (root !== undefined && root.length > 0) {
		const checkout = resolve(cwd, root);
		return { mode: "source-checkout", root: checkout, command: join(checkout, "prime-agent.sh"), leadingArgs: [] };
	}
	return undefined;
}

/** A semver version only: the version may later name a directory, so it never carries a path separator. */
const VERSION = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*(?![^\s])/;

function run(
	command: string,
	args: readonly string[],
	options: {
		readonly env: Readonly<Record<string, string>>;
		readonly cwd: string;
		readonly timeoutMs: number;
		/** Include stderr: Prime prints its version there in some modes. */
		readonly withStderr?: boolean;
	},
): Promise<string | undefined> {
	return new Promise((done) => {
		execFile(
			command,
			[...args],
			{ env: { ...options.env }, cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8", windowsHide: true },
			(error, stdout, stderr) =>
				done(error !== null ? undefined : options.withStderr === true ? `${stdout} ${stderr}` : stdout),
		);
	});
}

/**
 * Read the identity of an installation: `--version` in the given environment (nothing inherited), and for a source
 * checkout its HEAD commit and whether tracked files are modified. Rejects when no version can be read.
 */
export async function readPrimeRuntimeIdentityV0(
	installation: PrimeInstallationV0,
	options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string; readonly timeoutMs?: number },
): Promise<PrimeRuntimeIdentityV0> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const output = await run(installation.command, [...installation.leadingArgs, "--version"], {
		...options,
		timeoutMs,
		withStderr: true,
	});
	const version = output === undefined ? undefined : VERSION.exec(output)?.[0];
	if (version === undefined) throw new Error("Could not read a Prime version from --version");
	if (installation.mode === "binary") return { version, installation };
	const git = (args: readonly string[]) =>
		run("git", ["-C", installation.root, ...args], { env: options.env, cwd: options.cwd, timeoutMs });
	const head = (await git(["rev-parse", "HEAD"]))?.trim();
	const status = await git(["status", "--porcelain", "--untracked-files=no"]);
	const commit = head !== undefined && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
	const tree =
		commit === undefined || status === undefined ? "unknown" : status.trim().length === 0 ? "clean" : "dirty";
	return { version, installation, source: { ...(commit === undefined ? {} : { commit }), tree } };
}
