#!/usr/bin/env node

// Typecheck the Standard Cockpit's DOM modules. They need the DOM lib, which the root program must not load: DOM
// globals would retype fetch and other APIs for every Node package. The cockpit program reaches those packages
// through type imports, and they are typechecked without DOM by the root program, so only diagnostics in the
// cockpit's own files fail this check; the rest are counted and reported.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const result = spawnSync(
	process.execPath,
	[tsc, "--noEmit", "--pretty", "false", "-p", "packages/endophasia/cockpit/tsconfig.json"],
	{ encoding: "utf8" },
);
if (result.error) throw result.error;

const diagnostics = `${result.stdout}${result.stderr}`
	.split("\n")
	.filter((line) => /error TS\d+:/.test(line));
const own = diagnostics.filter((line) => line.startsWith("packages/endophasia/cockpit/") || !/^\S+\(\d+,\d+\)/.test(line));
const external = diagnostics.length - own.length;

if (own.length > 0) {
	console.error(own.join("\n"));
	console.error(`Standard Cockpit DOM typecheck failed with ${own.length} error(s).`);
	process.exit(1);
}
console.log(
	`Standard Cockpit DOM typecheck passed${external > 0 ? ` (${external} diagnostic(s) outside the cockpit, checked without DOM by the root program)` : ""}.`,
);
