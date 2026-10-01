// PR #26 process-crash and concurrent-reader witnesses; no Prime process or provider traffic.
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { installReferenceDirectory } from "../../../research/prime-conformance/reference-swap.ts";

const [mode, staging, target] = process.argv.slice(2);
if (mode === "reader") {
	process.stdout.write("ready\n");
	let reads = 0;
	const failures = [];
	const until = performance.now() + 500;
	while (performance.now() < until) {
		try {
			const report = readFileSync(join(target, "report.json"), "utf8");
			if (!['"old"\n', '"new"\n'].includes(report)) failures.push("incomplete report");
			reads++;
		} catch {
			failures.push("missing target");
		}
	}
	process.stdout.write(`${JSON.stringify({ reads, failures })}\n`);
} else {
	if (mode === "after") {
		// If replacement regresses to two renames, freeze immediately after it removes the visible target.
		const rename = fs.renameSync;
		fs.renameSync = (source, destination) => {
			rename(source, destination);
			if (source === target) {
				process.stdout.write("ready\n");
				process.kill(process.pid, "SIGSTOP");
			}
		};
		syncBuiltinESMExports();
		installReferenceDirectory(staging, target);
	}
	process.stdout.write("ready\n", () => process.kill(process.pid, "SIGSTOP"));
}
