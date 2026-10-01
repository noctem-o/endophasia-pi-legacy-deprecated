import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { assertPlainPath } from "./files.ts";

const sourceName = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/;
// Built from scratch: inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, ...) select another repository despite -C, and
// system/global configuration could install an fsmonitor that reports files as unchanged. Only the checkout's own
// configuration applies, replacement objects are disabled and fsmonitor is off on every call.
const gitEnv: Record<string, string> = {
	PATH: process.env.PATH ?? "",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: devNull,
	GIT_ATTR_NOSYSTEM: "1",
	GIT_NO_REPLACE_OBJECTS: "1",
	LC_ALL: "C",
};
function git(root: string, args: string[], input?: string): Buffer {
	return execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
		input,
		timeout: 30_000,
		maxBuffer: 128 * 1024 * 1024,
		env: gitEnv,
	});
}

/** Git walks up from a subdirectory; only the repository's own top level may supply an identity. */
function assertRepositoryRoot(root: string): void {
	const absolute = assertPlainPath(root, "directory");
	if (resolve(git(absolute, ["rev-parse", "--show-toplevel"]).toString().trim()) !== absolute)
		throw new Error("repository top level required");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
/** Raw `ls-tree -z` records. Paths must be valid UTF-8: lossy decoding would let distinct raw paths share a digest. */
function treeEntries(root: string, commit: string): { mode: string; type: string; oid: string; name: string }[] {
	const output = git(root, ["ls-tree", "-r", "-z", commit]);
	const entries = [];
	for (let start = 0; start < output.length; ) {
		const end = output.indexOf(0, start);
		if (end < 0) throw new Error("invalid tree listing");
		const record = output.subarray(start, end);
		const tab = record.indexOf(9);
		if (tab < 0) throw new Error("invalid tree listing");
		const [mode, type, oid] = record.subarray(0, tab).toString("latin1").split(" ");
		let name: string;
		try {
			name = strictUtf8.decode(record.subarray(tab + 1));
		} catch {
			throw new Error("tracked paths must be valid UTF-8");
		}
		entries.push({ mode: mode!, type: type!, oid: oid!, name });
		start = end + 1;
	}
	return entries;
}

/** Object IDs use the repository's hash: 40 hex digits for SHA-1, 64 for SHA-256. */
const objectIdLength = { sha1: 40, sha256: 64 } as const;
function objectFormat(root: string): keyof typeof objectIdLength {
	const format = git(root, ["rev-parse", "--show-object-format"]).toString().trim();
	if (format !== "sha1" && format !== "sha256") throw new Error("unsupported object format");
	return format;
}
function blobId(format: keyof typeof objectIdLength, bytes: Buffer): string {
	return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Hash tracked JS/TS source names/NUL/bytes/NUL at an exact commit, without checking out or executing it.
 * This is a JS/TS fingerprint. The exact commit binds all tracked content; studies must bind other execution inputs.
 */
export function sourceDigestAtCommit(root: string, commit: string): string {
	assertRepositoryRoot(root);
	const length = objectIdLength[objectFormat(root)];
	if (!/^[0-9a-f]+$/.test(commit) || commit.length !== length) throw new Error("exact commit required");
	if (
		git(root, ["rev-parse", `${commit}^{commit}`])
			.toString()
			.trim() !== commit
	)
		throw new Error("commit required");
	const entries = treeEntries(root, commit)
		.filter((entry) => sourceName.test(entry.name))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (!entries.length || entries.some((e) => e.type !== "blob" || !["100644", "100755"].includes(e.mode)))
		throw new Error("plain tracked source required");
	const blobs = git(root, ["cat-file", "--batch"], `${entries.map((entry) => entry.oid).join("\n")}\n`);
	const hash = createHash("sha256");
	let offset = 0;
	for (const entry of entries) {
		const end = blobs.indexOf(10, offset);
		const [oid, type, sizeText] = blobs.subarray(offset, end).toString().split(" ");
		const size = Number(sizeText);
		if (
			end < offset ||
			oid !== entry.oid ||
			type !== "blob" ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			end + 1 + size >= blobs.length
		)
			throw new Error("invalid source object");
		hash
			.update(entry.name)
			.update("\0")
			.update(blobs.subarray(end + 1, end + 1 + size))
			.update("\0");
		offset = end + size + 2;
	}
	return hash.digest("hex");
}

/** Call before and after capture and require identical results. Ignored execution inputs need study-specific guards. */
export function cleanRepositoryIdentity(root: string): { commit: string; sourceDigest: string } {
	assertRepositoryRoot(root);
	if (git(root, ["status", "--porcelain", "--untracked-files=all"]).length) throw new Error("dirty instrument");
	const commit = git(root, ["rev-parse", "HEAD"]).toString().trim();
	const sourceDigest = sourceDigestAtCommit(root, commit);
	const format = objectFormat(root);
	for (const { mode, type, oid, name } of treeEntries(root, commit)) {
		if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("plain tracked files required");
		const path = assertPlainPath(join(root, name), "file");
		// 100755 requires the owner execute bit (Git's own rule); 100644 permits no execute bit at all.
		const permissions = lstatSync(path).mode;
		if (mode === "100755" ? (permissions & 0o100) === 0 : (permissions & 0o111) !== 0)
			throw new Error(`tracked executable mode differs from commit: ${name}`);
		const bytes = readFileSync(path);
		// Compare every tracked file, including configuration and inputs hidden by index flags.
		if (blobId(format, bytes) !== oid) {
			// Only tracked text/eol policy permits CRLF checkout bytes; custom filters cannot excuse differences.
			const localAttributes = resolve(
				root,
				git(root, ["rev-parse", "--git-path", "info/attributes"]).toString().trim(),
			);
			if (existsSync(localAttributes)) throw new Error("unbound local attributes cannot permit byte differences");
			const attrs = git(root, [
				"-c",
				"core.attributesFile=/dev/null",
				"check-attr",
				"--cached",
				"-z",
				"text",
				"eol",
				"--",
				name,
			])
				.toString()
				.split("\0");
			const normalized = Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
			if (attrs[2] !== "set" || attrs[5] !== "crlf" || blobId(format, normalized) !== oid)
				throw new Error(`tracked execution differs from commit: ${name}`);
		}
	}
	if (
		git(root, ["status", "--porcelain", "--untracked-files=all"]).length ||
		git(root, ["rev-parse", "HEAD"]).toString().trim() !== commit
	)
		throw new Error("instrument changed or tracked execution differs from commit");
	return { commit, sourceDigest };
}
