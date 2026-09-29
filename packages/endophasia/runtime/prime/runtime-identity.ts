// Prime RPC Runtime Ingress v0: which Prime is running. This is runtime identity, not conformance certification: it
// records what can be known (the reported version, how Prime is installed, a source checkout's commit and tree state)
// and claims nothing more. A Prime semantic adapter decides whether an identity belongs to a profile it supports.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { createReadStream } from "node:fs";
import { access, constants, lstat, opendir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { Readable } from "node:stream";
import { PrimeProcessGroupV0 } from "./process-group.ts";

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
	readonly source?: {
		readonly commit?: string;
		readonly tree: "clean" | "dirty" | "unknown";
		/**
		 * SHA-256 over the git-ignored build output the launcher loads (every file under packages/<name>/dist, by relative
		 * path and content, in a stable order), as the conformance probe computes it. A clean tracked tree says nothing
		 * about that output, so a commit and a clean tree alone do not identify what ran. Absent when there is no build
		 * output or any entry is a symlink (its target is not hashed): the build is then unverified. It detects rebuilt or
		 * edited output, not whether that output was built from `commit`.
		 */
		readonly artifactsHash?: string;
	};
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

/**
 * A SemVer 2.0.0 version (no leading zeros in numeric identifiers, dot-separated pre-release and build identifiers),
 * standing alone as a whitespace-delimited word and optionally prefixed with "v", so a version-like segment of a path
 * such as /opt/prime/1.2.3 is never taken for one. Prime 0.9.6 prints the bare version.
 */
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_ID = "[0-9A-Za-z-]+";
const VERSION = new RegExp(
	`(?<![^\\s])v?(${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}` +
		`(?:-${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*)?(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?)(?![^\\s])`,
	"g",
);
/** Output beyond this is not a version report; the command is stopped and nothing is read from it. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** The index listing of a source checkout (Prime 0.9.6: 1,264 entries, about 68 KB). */
const MAX_INDEX_LISTING_BYTES = 16 * 1024 * 1024;

/**
 * Run a short command with exactly the given environment and return its output on exit code 0. It runs in a process
 * group this process owns (see process-group.ts): once it exited, anything it left in the group (a descendant,
 * detached or holding the pipes) is killed, so nothing outlives the read and no recycled group ID is ever signalled.
 * Bounded: at the timeout, or past MAX_OUTPUT_BYTES, the group is killed and the result is undefined at once.
 */
function run(
	command: string,
	args: readonly string[],
	options: {
		readonly env: Readonly<Record<string, string>>;
		readonly cwd: string;
		readonly timeoutMs: number;
		/** Include stderr: Prime prints its version there in some modes. */
		readonly withStderr?: boolean;
		/** Output bound for this command; MAX_OUTPUT_BYTES by default. */
		readonly maxOutputBytes?: number;
	},
): Promise<string | undefined> {
	return new Promise((done) => {
		const group = new PrimeProcessGroupV0(command, args, {
			cwd: options.cwd,
			env: options.env,
			stderr: options.withStderr === true ? "pipe" : "ignore",
		});
		group.stdin?.on("error", () => {});
		group.stdin?.end();
		// Registered now, so a stream that closes early is not missed.
		const closed = (stream: Readable | null) =>
			stream === null ? Promise.resolve() : new Promise<void>((resolve) => stream.once("close", () => resolve()));
		const streamsClosed = Promise.all([closed(group.stdout), closed(group.stderr)]);
		// Kept per stream and joined with a newline, so the two streams never run together into one word.
		const streams: [Buffer[], Buffer[]] = [[], []];
		let length = 0;
		let settled = false;
		const finish = (output: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// The read settles only once the group is gone (release is bounded), so nothing it started outlives it.
			void group.release().then(() => done(output));
		};
		const stop = () => {
			group.stdout?.destroy();
			group.stderr?.destroy();
			finish(undefined);
		};
		const timer = setTimeout(stop, options.timeoutMs);
		const collect = (into: Buffer[]) => (chunk: Buffer) => {
			length += chunk.length;
			if (length > (options.maxOutputBytes ?? MAX_OUTPUT_BYTES)) stop();
			else into.push(chunk);
		};
		group.stdout?.on("data", collect(streams[0]));
		group.stderr?.on("data", collect(streams[1]));
		void group.exited.then(async (exit) => {
			// What the command wrote before it exited is still read; anything it left behind is killed first, so a
			// descendant holding the pipes cannot delay the read.
			await group.release();
			await streamsClosed;
			let output: string | undefined;
			try {
				const decoder = new TextDecoder("utf-8", { fatal: true });
				output =
					exit.code === 0 && !exit.spawnFailed
						? (options.withStderr === true ? streams : streams.slice(0, 1))
								.map((chunks) => decoder.decode(Buffer.concat(chunks)))
								.join("\n")
						: undefined;
			} catch {
				output = undefined;
			}
			finish(output);
		});
	});
}

/** How many times a source checkout's identity is read before a checkout that keeps changing is reported. */
const IDENTITY_ATTEMPTS = 3;

/**
 * Read the identity of an installation: `--version` in the given environment (nothing inherited), and for a source
 * checkout its HEAD commit and whether tracked files are modified, read as one stable snapshot. Rejects when no
 * version can be read, or when the checkout keeps changing while it is read.
 */
export async function readPrimeRuntimeIdentityV0(
	installation: PrimeInstallationV0,
	options: {
		readonly env: Readonly<Record<string, string>>;
		readonly cwd: string;
		readonly timeoutMs?: number;
		/**
		 * The git executable for the provenance probes. By default git is resolved on this process's PATH, never on the
		 * PATH in `env`: that environment belongs to Prime, and a git shim placed there could fabricate a repository.
		 */
		readonly gitCommand?: string;
	},
): Promise<PrimeRuntimeIdentityV0> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const readVersion = async () => {
		const output = await run(installation.command, [...installation.leadingArgs, "--version"], {
			...options,
			timeoutMs,
			withStderr: true,
		});
		// Exactly one distinct version: output that also names another (e.g. a launcher's Node version) is ambiguous.
		const versions = new Set(output === undefined ? [] : [...output.matchAll(VERSION)].map((match) => match[1]));
		const [version] = versions;
		if (versions.size !== 1 || version === undefined)
			throw new Error("Could not read a Prime version from --version");
		return version;
	};
	if (installation.mode === "binary") return { version: await readVersion(), installation };
	// Git's own GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS...) can select another
	// repository or rewrite configuration despite -C, so the probes run without any of them.
	const gitEnv = Object.fromEntries(
		Object.entries(options.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
	);
	const gitCommand = options.gitCommand ?? (await resolveOnPath("git", process.env.PATH ?? ""));
	if (gitCommand === undefined) return { version: await readVersion(), installation, source: { tree: "unknown" } };
	const git = (args: readonly string[]) =>
		run(gitCommand, ["-C", installation.root, ...args], { env: gitEnv, cwd: options.cwd, timeoutMs });
	// Git walks up from the root: a root that is not itself a checkout but sits inside another repository would report
	// that ancestor's commit. Provenance is accepted only when the repository's top level is the configured root.
	const toplevel = (await git(["rev-parse", "--show-toplevel"]))?.trim();
	if (toplevel === undefined || !(await sameDirectory(toplevel, installation.root))) {
		return { version: await readVersion(), installation, source: { tree: "unknown" } };
	}
	// The version and the provenance must describe one runtime. HEAD, the tracked-file status and the launcher file
	// are read before and after --version; if anything moved (an updater switched or edited the checkout), the whole
	// read is repeated, and a checkout that keeps changing is an error rather than a mixed identity.
	const snapshot = async () => {
		const head = (await git(["rev-parse", "HEAD"]))?.trim();
		const status = await git(["status", "--porcelain", "--untracked-files=no"]);
		// The launcher is what actually runs: it must be a regular file (not a symlink to code elsewhere) that git
		// tracks, so the commit and the tracked-file status describe it. Its stat also shows a replacement mid-read.
		const launcher = await lstat(installation.command).then(
			(file) =>
				file.isFile()
					? `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`
					: "not-a-regular-file",
			() => undefined,
		);
		const launcherEntry = await git(["ls-files", "--stage", "--", relative(installation.root, installation.command)]);
		const launcherTracked = launcherEntry !== undefined && /^100(?:644|755) [0-9a-f]+ 0\t/.test(launcherEntry);
		const artifactsHash = await hashBuildOutput(installation.root, Date.now() + timeoutMs);
		// `git status` does not see modifications to entries flagged assume-unchanged or skip-worktree (or unmerged
		// ones): every index entry must carry the plain "H" tag, or the tracked-file status proves nothing.
		const index = await run(gitCommand, ["-C", installation.root, "ls-files", "-v", "-z"], {
			env: gitEnv,
			cwd: options.cwd,
			timeoutMs,
			maxOutputBytes: MAX_INDEX_LISTING_BYTES,
		});
		const indexPlain =
			index
				?.split("\0")
				.filter((entry) => entry.length > 0)
				.every((entry) => entry.startsWith("H ")) === true;
		return { head, status, launcher, launcherTracked, indexPlain, artifactsHash };
	};
	for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt++) {
		const before = await snapshot();
		const version = await readVersion();
		const after = await snapshot();
		if (
			before.head !== after.head ||
			before.status !== after.status ||
			before.launcher !== after.launcher ||
			before.launcherTracked !== after.launcherTracked ||
			before.indexPlain !== after.indexPlain ||
			before.artifactsHash !== after.artifactsHash
		) {
			continue;
		}
		// A SHA-1 or SHA-256 object ID: git supports both object formats.
		const head = before.head;
		const status = before.status;
		// A commit is reported only with a readable tree state: a HEAD without its status says nothing about what ran.
		// And only when the launcher that ran is a tracked regular file: untracked or symlinked launcher code is not
		// described by the commit, so the provenance is unknown.
		const launcherVerified =
			before.indexPlain &&
			before.launcherTracked &&
			before.launcher !== undefined &&
			before.launcher !== "not-a-regular-file";
		if (!launcherVerified) return { version, installation, source: { tree: "unknown" } };
		const commit =
			status !== undefined && head !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head : undefined;
		const tree =
			commit === undefined || status === undefined ? "unknown" : status.trim().length === 0 ? "clean" : "dirty";
		const artifactsHash = before.artifactsHash;
		return {
			version,
			installation,
			source: {
				...(commit === undefined ? {} : { commit }),
				tree,
				...(artifactsHash === undefined ? {} : { artifactsHash }),
			},
		};
	}
	throw new Error("The Prime checkout changed while its identity was read");
}

/** Bounds on hashing build output (Prime 0.9.6's is 400 files, about 5 MB). Past either, the build is unverified. */
const MAX_BUILD_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_BUILD_OUTPUT_FILES = 100_000;
/** Directories and files together, and nesting depth: empty directories cost traversal time too. */
const MAX_BUILD_OUTPUT_ENTRIES = 200_000;
const MAX_BUILD_OUTPUT_DEPTH = 64;

/** Code-unit order: the same on every machine, unlike localeCompare, which depends on the locale and ICU version. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SHA-256 over every file under packages/<name>/dist in a checkout, by relative path (always "/"-separated) and
 * content, in code-unit order. For Prime 0.9.6's build output this equals the conformance probe's hashBuildOutputV0
 * (whose locale order agrees with code-unit order there) and the recorded evidence hash. Files are streamed into the
 * digest, never held whole. Undefined when there is none, when any entry is a symlink (Node would follow it to code
 * this walk does not hash), when a file contains a NUL byte (see below), when the output exceeds its bounds or the
 * deadline, or when it cannot be read.
 */
async function hashBuildOutput(checkout: string, deadline: number): Promise<string | undefined> {
	const hash = createHash("sha256");
	let files = 0;
	let bytes = 0;
	class Unverifiable extends Error {}
	// The deadline is enforced on every awaited filesystem operation, not only between them: a read on a stalled
	// network or FUSE filesystem may never complete. At the deadline the controller aborts open streams, and every
	// other wait is raced against it.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
	const aborted = new Promise<never>((_, reject) =>
		controller.signal.addEventListener("abort", () => reject(new Unverifiable()), { once: true }),
	);
	aborted.catch(() => {});
	const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted]);
	const hashFile = async (path: string): Promise<void> => {
		// "/"-separated whatever the host, so the digest does not depend on the operating system.
		hash.update(relative(checkout, path).split(sep).join("/")).update("\0");
		for await (const chunk of createReadStream(path, { signal: controller.signal }) as AsyncIterable<Buffer>) {
			// The digest frames each entry as path NUL content NUL. Paths never contain NUL, so the stream splits back
			// into exactly one sequence of entries only when no content does either: a file with a NUL byte could make
			// two different trees hash alike, so such output is unverified.
			if (chunk.includes(0)) throw new Unverifiable();
			bytes += chunk.length;
			if (bytes > MAX_BUILD_OUTPUT_BYTES || Date.now() > deadline) throw new Unverifiable();
			hash.update(chunk);
		}
		hash.update("\0");
		files++;
		if (files > MAX_BUILD_OUTPUT_FILES) throw new Unverifiable();
	};
	let entries = 0;
	/**
	 * A directory's entries in code-unit order, read as a stream so that a huge directory counts against the entry bound
	 * (and the deadline) entry by entry, before its names are ever held or sorted.
	 */
	const list = async (path: string): Promise<Dirent[]> => {
		const found: Dirent[] = [];
		const directory = await bounded(opendir(path));
		try {
			for (let entry = await bounded(directory.read()); entry !== null; entry = await bounded(directory.read())) {
				if (Date.now() > deadline || ++entries > MAX_BUILD_OUTPUT_ENTRIES) throw new Unverifiable();
				found.push(entry);
			}
		} finally {
			await directory.close().catch(() => {});
		}
		return found.sort((a, b) => byCodeUnit(a.name, b.name));
	};
	// Depth-first in code-unit order, with an explicit stack (no recursion to overflow), checking the deadline and the
	// entry and depth bounds at every step, so a wide or deep tree of empty directories is bounded too.
	const walk = async (root: string): Promise<void> => {
		const stack: { readonly path: string; readonly directory: boolean; readonly depth: number }[] = [
			{ path: root, directory: true, depth: 0 },
		];
		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			if (Date.now() > deadline) throw new Unverifiable();
			if (!next.directory) {
				await hashFile(next.path);
				continue;
			}
			if (next.depth > MAX_BUILD_OUTPUT_DEPTH) throw new Unverifiable();
			const children = await list(next.path);
			for (let index = children.length - 1; index >= 0; index--) {
				const entry = children[index];
				// Only directories and regular files are hashable. A symlink, FIFO, socket or device could still be loaded as
				// a module (a FIFO yields whatever a writer sends), so any of them makes the build output unverifiable.
				if (!entry.isDirectory() && !entry.isFile()) throw new Unverifiable();
				stack.push({ path: join(next.path, entry.name), directory: entry.isDirectory(), depth: next.depth + 1 });
			}
		}
	};
	// Every path component the launcher resolves through is checked without following links: a symlinked packages/,
	// packages/<name> or dist would load code reached relative to its target, which this hash does not describe.
	const kind = (path: string) =>
		bounded(lstat(path)).then(
			(entry) => (entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "other"),
			() => "missing" as const,
		);
	try {
		const packages = join(checkout, "packages");
		const packagesKind = await kind(packages);
		if (packagesKind === "link") return undefined;
		// The package level is bounded like the rest: every name counts against the entry bound and the deadline.
		const names = packagesKind === "directory" ? (await list(packages)).map((entry) => entry.name) : [];
		for (const name of names) {
			if (Date.now() > deadline) throw new Unverifiable();
			const packageKind = await kind(join(packages, name));
			if (packageKind === "link") return undefined;
			if (packageKind !== "directory") continue;
			const dist = join(packages, name, "dist");
			const distKind = await kind(dist);
			if (distKind === "link") return undefined;
			if (distKind === "directory") await walk(dist);
		}
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
	return files === 0 ? undefined : hash.digest("hex");
}

/**
 * The first executable named `name` on `path` (a PATH-style list), as an absolute path; on Windows also with .exe and
 * .cmd. Undefined when none is found.
 */
async function resolveOnPath(name: string, path: string): Promise<string | undefined> {
	const names = process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`] : [name];
	for (const directory of path.split(delimiter)) {
		if (directory.length === 0 || !isAbsolute(directory)) continue;
		for (const candidate of names) {
			const full = join(directory, candidate);
			const found = await access(full, constants.X_OK).then(
				() => lstat(full).then((entry) => !entry.isDirectory()),
				() => false,
			);
			if (found) return full;
		}
	}
	return undefined;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([realpath(a), realpath(b)]);
		return left === right;
	} catch {
		return false;
	}
}
