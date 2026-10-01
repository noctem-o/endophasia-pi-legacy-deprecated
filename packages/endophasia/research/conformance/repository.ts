import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPlainPath } from "./files.ts";

const sourceName = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/;
function git(root: string, args: string[], input?: string): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		input,
		timeout: 30_000,
		maxBuffer: 128 * 1024 * 1024,
		env: { ...process.env, GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" },
	});
}

/** Hash tracked JS/TS source names/NUL/bytes/NUL at an exact commit, without checking out or executing it.
 * This is a JS/TS fingerprint. The exact commit binds all tracked content; studies must bind other execution inputs.
 */
export function sourceDigestAtCommit(root: string, commit: string): string {
	assertPlainPath(root, "directory");
	if (!/^[0-9a-f]{40}$/.test(commit) || commit.length !== 40) throw new Error("exact commit required");
	if (
		git(root, ["rev-parse", `${commit}^{commit}`])
			.toString()
			.trim() !== commit
	)
		throw new Error("commit required");
	const entries = git(root, ["ls-tree", "-r", "-z", commit])
		.toString()
		.split("\0")
		.filter(Boolean)
		.map((entry) => {
			const tab = entry.indexOf("\t");
			const [mode, type, oid] = entry.slice(0, tab).split(" ");
			return { mode, type, oid, name: entry.slice(tab + 1) };
		})
		.filter((entry) => sourceName.test(entry.name))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	if (!entries.length || entries.some((e) => e.type !== "blob" || !["100644", "100755"].includes(e.mode!)))
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
	assertPlainPath(root, "directory");
	if (git(root, ["status", "--porcelain", "--untracked-files=all"]).length) throw new Error("dirty instrument");
	const commit = git(root, ["rev-parse", "HEAD"]).toString().trim();
	const sourceDigest = sourceDigestAtCommit(root, commit);
	for (const entry of git(root, ["ls-tree", "-r", "-z", commit]).toString().split("\0").filter(Boolean)) {
		const tab = entry.indexOf("\t");
		const [mode, type, oid] = entry.slice(0, tab).split(" ");
		if (type !== "blob" || !["100644", "100755"].includes(mode!)) throw new Error("plain tracked files required");
		const name = entry.slice(tab + 1);
		const path = assertPlainPath(join(root, name), "file");
		if ((lstatSync(path).mode & 0o111) !== (mode === "100755" ? 0o111 : 0))
			throw new Error(`tracked executable mode differs from commit: ${name}`);
		const bytes = readFileSync(path);
		// Compare every tracked file, including configuration and inputs hidden by index flags.
		if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== oid) {
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
			if (
				attrs[2] !== "set" ||
				attrs[5] !== "crlf" ||
				createHash("sha1").update(`blob ${normalized.length}\0`).update(normalized).digest("hex") !== oid
			)
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
