// Offline ACP transport adversary. Never imports or launches Prime.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
const mode = process.argv[2];
if (mode === "hold-stdout") {
 setTimeout(() => process.exit(0), 8_000);
} else {
const lines = createInterface({ input: process.stdin });
const write = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	const response = { jsonrpc: "2.0", id: request.id, result: { ok: true } };
	if (mode === "descendant-stdout") {
 const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "hold-stdout"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
 child.unref();
 child.once("spawn", () => { write({ ...response, result: { descendantPid: child.pid } }); process.exit(0); });
}
else if (mode === "exit") process.exit(7);
	else if (mode === "duplicate") { write(response); write(response); }
	else if (mode === "unknown-id") write({ ...response, id: 999 });
	else if (mode === "ambiguous") write({ ...response, error: { code: -1, message: "private" } });
	else if (mode === "wrong-version") write({ ...response, jsonrpc: "1.0" });
	else if (mode === "wrong-id") write({ ...response, id: "1" });
	else if (mode === "malformed") process.stdout.write('{"private":"probe_priv_prompt"\n');
	else if (mode === "nonobject") process.stdout.write("[]\n");
	else if (mode === "server-request") write({ jsonrpc: "2.0", id: 9, method: "session/update", params: {} });
	else if (mode === "bad-error") write({ jsonrpc: "2.0", id: request.id, error: { code: "-1", message: "private" } });
	else if (mode === "error") write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "probe_priv_error_detail", data: { text: "probe_priv_tool_result" } } });
	else if (mode === "final") { process.stdout.write(JSON.stringify(response)); process.exit(0); }
	else if (mode === "split") { for (const byte of Buffer.from(`${JSON.stringify(response)}\n`)) process.stdout.write(Buffer.from([byte])); }
	else if (mode === "bad-update") write({ jsonrpc: "2.0", method: "session/update", params: {} });
	else write(response);
});

}
