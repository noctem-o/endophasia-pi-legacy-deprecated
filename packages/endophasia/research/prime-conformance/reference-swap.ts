// Research publication on Linux: one rename exchange, never a remove-then-install window or copy fallback.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function syncTree(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() && !stat.isFile()) throw new Error("reference must contain plain files/directories");
	if (stat.isDirectory()) for (const name of readdirSync(path)) syncTree(join(path, name));
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** On success the old complete reference occupies staging; callers may remove it after the exchange.
 * If interrupted before or after the syscall, target names the complete old or new directory. A filesystem/tool
 * without atomic exchange refuses replacement and preserves the old target. Readers needing a multi-file snapshot
 * must hold an opened directory or avoid concurrent publication; separate pathname opens can straddle an exchange.
 */
export function installReferenceDirectory(staging: string, target: string): void {
	if (process.platform !== "linux" || dirname(resolve(staging)) !== dirname(resolve(target)))
		throw new Error("reference swap requires Linux sibling directories");
	syncTree(staging);
	if (existsSync(target)) {
		if (!lstatSync(target).isDirectory()) throw new Error("reference target must be a plain directory");
		execFileSync("/usr/bin/mv", ["--exchange", "--no-copy", "--no-target-directory", "--", staging, target], {
			timeout: 30_000,
			stdio: "pipe",
		});
	} else renameSync(staging, target);
	const fd = openSync(dirname(resolve(target)), "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
