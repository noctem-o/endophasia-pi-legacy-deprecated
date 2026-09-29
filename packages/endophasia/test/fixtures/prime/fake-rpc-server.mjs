// Offline stand-in for `prime-agent --mode rpc`, used by prime-conformance.test.ts. The mode argument picks one
// protocol behavior; every command is read as one LF-terminated JSON record.
const mode = process.argv[2] ?? "echo";
let buffer = "";
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (command) => ({ type: "response", id: command.id, command: command.type, success: true });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const command = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		handle(command);
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));

const held = [];
function handle(command) {
	switch (mode) {
		case "echo":
			write({ type: "future_event_kind", note: "forward compatible" });
			write(respond(command));
			return;
		case "reverse":
			// Answer the second command before the first.
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
			write({ ...respond(command), id: "not-a-probe-id" });
			write(respond(command));
			return;
		case "malformed":
			process.stdout.write('{"type":"response",\n');
			process.stdout.write("[1,2]\n");
			write(respond(command));
			return;
		case "wrong-command":
			write({ ...respond(command), command: "get_messages" });
			return;
		case "trailing-exit":
			// Answer, then emit a malformed record and exit at once: the record must still be counted.
			write(respond(command));
			process.stdout.write("{not json\n", () => process.exit(0));
			return;
		case "exit":
			process.exit(3);
			return;
		case "split":
			// One record in three writes, splitting a multi-byte character.
			{
				const bytes = Buffer.from(`${JSON.stringify({ ...respond(command), data: { text: "é " } })}\r\n`);
				const cut = bytes.indexOf(0xc3) + 1;
				process.stdout.write(bytes.subarray(0, cut));
				setTimeout(() => {
					process.stdout.write(bytes.subarray(cut, cut + 3));
					setTimeout(() => process.stdout.write(bytes.subarray(cut + 3)), 10);
				}, 10);
			}
			return;
	}
}
