// Offline stand-in for `prime-agent --mode rpc`, used by prime-runtime-ingress.test.ts. Launched as
// `node fake-prime-rpc.mjs --mode rpc <mode>`: the mode picks one protocol behavior. Raw events carry privacy sentinels.
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";

const mode = process.argv[4] ?? "echo";
const SENTINEL = { prompt: "PROMPT_SENTINEL", output: "ASSISTANT_SENTINEL", args: "TOOL_ARGS_SENTINEL" };
const line = (value) => `${JSON.stringify(value)}\n`;
const write = (value, done) => process.stdout.write(line(value), done);
const respond = (command, extra = {}) => ({ type: "response", id: command.id, command: command.type, success: true, ...extra });

let buffer = "";
process.stdin.setEncoding("utf8");
// "stall" never reads its input, so the pipe fills and the connection's writes back up.
process.stdin.on(mode === "stall" ? "end" : "data", (chunk = "") => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const command = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		handle(command);
		newline = buffer.indexOf("\n");
	}
});
const lingers = ["ignore-stdin-end", "ignore-sigterm", "close-stdin", "descendant-ignores-sigterm", "stall"].includes(
	mode,
);
if (mode === "stall") process.stdin.pause();
process.stdin.on("end", () => {
	if (lingers) return;
	process.exit(0);
});
if (mode === "ignore-sigterm") process.on("SIGTERM", () => {});
if (lingers) setInterval(() => {}, 1_000);

const held = [];
function handle(command) {
	switch (mode) {
		case "echo":
			write({ type: "message_update", delta: SENTINEL.output, note: " line separators" });
			write(respond(command, { data: { echoed: command.type } }));
			return;
		case "env":
			write(respond(command, { data: { hasOpenAiKey: process.env.OPENAI_API_KEY !== undefined, keys: Object.keys(process.env).sort() } }));
			return;
		case "refuse":
			write({ type: "response", id: command.id, command: command.type, success: false, error: `refused ${SENTINEL.prompt}` });
			return;
		case "reverse":
			held.push(command);
			if (held.length === 2) {
				write(respond(held[1]));
				write(respond(held[0]));
			}
			return;
		case "duplicate":
			write(respond(command));
			write(respond(command));
			return;
		case "unknown-id":
			write({ ...respond(command), id: "not-a-connection-id" });
			write(respond(command));
			return;
		case "no-id":
			write({ type: "response", command: command.type, success: false, error: "parse failure" });
			write(respond(command));
			return;
		case "wrong-command":
			write(respond(command, { command: "get_messages" }));
			return;
		case "extension-ui":
			// Prime opens a dialog and blocks on an extension_ui_response with the same ID; that response gets no reply.
			if (command.type === "extension_ui_response") {
				const { type, id, ...answer } = command;
				write({ type: "ui_answered", id, answer });
				return;
			}
			write({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: SENTINEL.prompt });
			write(respond(command));
			return;
		case "early-exit-descendant": {
			// A descendant in the group that does not hold stdout; Prime itself exits normally when its input ends.
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			child.on("spawn", () => write(respond(command, { data: { descendant: child.pid } })));
			return;
		}
		case "exit-with-descendant": {
			// Prime leaves a descendant that does not hold stdout, then exits by itself.
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			child.on("spawn", () =>
				write(respond(command, { data: { descendant: child.pid } }), () => process.exit(0)),
			);
			return;
		}
		case "success-with-error":
			write({ type: "response", id: command.id, command: command.type, success: true, error: SENTINEL.prompt });
			write(respond(command));
			return;
		case "malformed-response":
			write({ type: "response", id: command.id, command: command.type });
			write({ type: "response", id: command.id, command: command.type, success: false });
			write(respond(command));
			return;
		case "hostile-records": {
			// Blank line, malformed JSON, a JSON array, malformed UTF-8, a record without a type, then the response.
			process.stdout.write("\n");
			process.stdout.write(`{"type":"agent_start","prompt":"${SENTINEL.prompt}"\n`);
			process.stdout.write(`["${SENTINEL.args}"]\n`);
			process.stdout.write(Buffer.concat([Buffer.from(`{"type":"ev","x":"${SENTINEL.output}`), Buffer.from([0xff]), Buffer.from('"}\n')]));
			write({ note: SENTINEL.prompt });
			write(respond(command));
			return;
		}
		case "split": {
			// One chunk with two records, then one record split inside a multi-byte code point, with CRLF.
			process.stdout.write(`${line({ type: "turn_start" })}${line({ type: "turn_end", t: "  " })}`);
			const bytes = Buffer.from(`${JSON.stringify(respond(command, { data: { text: "é🙂" } }))}\r\n`);
			const cut = bytes.indexOf(0xc3) + 1;
			process.stdout.write(bytes.subarray(0, cut));
			setTimeout(() => {
				process.stdout.write(bytes.subarray(cut, cut + 3));
				setTimeout(() => process.stdout.write(bytes.subarray(cut + 3)), 10);
			}, 10);
			return;
		}
		case "interleave":
			write({ type: "agent_start" });
			write({ type: "message_end", message: { role: "assistant", content: SENTINEL.output } });
			write(respond(command));
			write({ type: "agent_end" });
			return;
		case "exit-pending":
			process.exit(3);
			return;
		case "trailing-exit":
			// Answer, then emit records and exit at once: records written before exit must still be decoded.
			write(respond(command));
			write({ type: "late_event" });
			process.stdout.write('{"type":"final_without_lf"}', () => process.exit(0));
			return;
		case "descendant":
			// A descendant inherits stdout and outlives this process.
			spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "ignore"] });
			write(respond(command), () => process.exit(0));
			return;
		case "ignore-stdin-end":
		case "ignore-sigterm":
			write(respond(command));
			return;
		case "close-stdin":
			// Answer, then close its input while staying alive: later writes to it fail with EPIPE.
			write(respond(command), () => {
				process.stdin.destroy();
				closeSync(0);
			});
			return;
		case "descendant-ignores-sigterm": {
			// A descendant in the same process group ignores SIGTERM and does not hold stdout; Prime itself stops on SIGTERM.
			const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
				stdio: "ignore",
			});
			child.on("spawn", () => setTimeout(() => write(respond(command, { data: { descendant: child.pid } })), 200));
			return;
		}
	}
}
