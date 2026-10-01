// Real process boundary for PR #27; stop or fail immediately around the exchange syscall.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { canonicalJson, sha256 } from "../../../research/conformance/json.ts";
import { publishReference } from "../../../research/conformance/reference.ts";

const [mode, parent] = process.argv.slice(2);
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
	if (command !== "/usr/bin/mv") return original(command, args, options);
	if (mode.endsWith("after")) original(command, args, options);
	if (mode.startsWith("failed")) throw new Error("injected exchange failure");
	process.stdout.write("ready\n");
	process.kill(process.pid, "SIGSTOP");
	return Buffer.alloc(0);
};
syncBuiltinESMExports();
const input = [{ path: "report.json", bytes: canonicalJson({ value: "new" }) }, { path: "runs/a.json", bytes: "{}\n" }];
publishReference(parent, "reference", input.map((m) => ({ path: m.path, sha256: sha256(m.bytes) })), input);
