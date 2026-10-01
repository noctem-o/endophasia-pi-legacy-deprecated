// Byte integrity and publication only. A study supplies its externally pinned complete inventory and sanitized bytes.
import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertMemberPath, assertPlainPath } from "./files.ts";
import { assertDigest, assertPlainJson, canonicalJson, sha256 } from "./json.ts";

export interface ReferenceMember {
	readonly path: string;
	readonly sha256: string;
}
export interface ReferenceBytes {
	readonly path: string;
	readonly bytes: string;
}
const MAX_BYTES = 16 * 1024 * 1024;

function inventory(value: unknown): ReferenceMember[] {
	assertPlainJson(value);
	if (!Array.isArray(value) || !value.length) throw new Error("reference inventory required");
	const members = value
		.map((entry) => {
			if (
				entry === null ||
				typeof entry !== "object" ||
				Array.isArray(entry) ||
				Object.keys(entry).sort().join() !== "path,sha256"
			)
				throw new Error("closed reference member required");
			assertMemberPath(entry.path);
			assertDigest(entry.sha256);
			return { path: entry.path, sha256: entry.sha256 };
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (
		members.some((m, i) =>
			members.some((other, j) => i !== j && (m.path === other.path || m.path.startsWith(`${other.path}/`))),
		)
	)
		throw new Error("duplicate or overlapping reference members");
	return members;
}

/** The manifest must be trusted/pinned separately. Computing an expectation from the bytes under test proves nothing. */
export function verifyReference(root: string, expected: unknown): { digest: string; members: number } {
	const members = inventory(expected);
	root = assertPlainPath(root, "directory");
	const found: string[] = [];
	let bytes = 0;
	const walk = (relative: string): void => {
		for (const name of readdirSync(join(root, relative))) {
			const member = relative ? `${relative}/${name}` : name;
			assertMemberPath(member);
			const path = join(root, member);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				assertPlainPath(path, "directory");
				if (!members.some((m) => m.path.startsWith(`${member}/`)))
					throw new Error("unexpected reference directory");
				walk(member);
			} else {
				assertPlainPath(path, "file");
				bytes += stat.size;
				if (bytes > MAX_BYTES) throw new Error("reference byte limit exceeded");
				const pin = members.find((m) => m.path === member);
				if (!pin || sha256(readFileSync(path)) !== pin.sha256) throw new Error("reference member/digest mismatch");
				found.push(member);
			}
		}
	};
	walk("");
	if (found.length !== members.length || members.some((m) => !found.includes(m.path)))
		throw new Error("missing reference member");
	return { digest: sha256(canonicalJson(members)), members: members.length };
}

function syncTree(path: string): void {
	const stat = lstatSync(path);
	assertPlainPath(path, stat.isDirectory() ? "directory" : "file");
	if (stat.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Same single-exchange mechanism as the audited writer, independently retained for future studies.
 * Linux + atomic exchange capable filesystem/GNU mv required. No copy/delete fallback. One publisher owns parent;
 * readers must avoid concurrent publication or hold a directory snapshot for multi-file reads. If interrupted or a
 * post-exchange sync fails, the visible target is complete old/new; a thrown error alone cannot say which is current.
 */
export function publishReference(parent: string, name: string, expected: unknown, input: unknown): void {
	const members = inventory(expected);
	assertPlainJson(input);
	assertMemberPath(name);
	if (name.includes("/") || process.platform !== "linux")
		throw new Error("publication requires Linux sibling directories");
	if (!Array.isArray(input) || input.length !== members.length) throw new Error("partial publication refused");
	const bytes = input.map((entry) => {
		if (
			entry === null ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			Object.keys(entry).sort().join() !== "bytes,path" ||
			typeof entry.bytes !== "string"
		)
			throw new Error("closed reference bytes required");
		assertMemberPath(entry.path);
		return { path: entry.path, bytes: entry.bytes };
	});
	if (
		new Set(bytes.map((m) => m.path)).size !== members.length ||
		bytes.reduce((n, m) => n + Buffer.byteLength(m.bytes), 0) > MAX_BYTES ||
		members.some((m) => !bytes.some((b) => b.path === m.path && sha256(b.bytes) === m.sha256))
	)
		throw new Error("publication inventory/digest mismatch");
	parent = assertPlainPath(parent, "directory");
	const target = join(parent, name);
	// lstat also detects dangling target links; existsSync alone would treat them as an absent reference.
	if (readdirSync(parent).includes(name)) assertPlainPath(target, "directory");
	const staging = mkdtempSync(join(parent, ".conformance-"));
	try {
		for (const member of bytes) {
			const path = join(staging, member.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, member.bytes, { flag: "wx" });
		}
		verifyReference(staging, members);
		syncTree(staging);
		if (existsSync(target))
			execFileSync("/usr/bin/mv", ["--exchange", "--no-copy", "--no-target-directory", "--", staging, target], {
				timeout: 30_000,
				stdio: "pipe",
			});
		else renameSync(staging, target);
		const fd = openSync(parent, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
