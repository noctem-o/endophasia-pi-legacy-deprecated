// Foreground launcher for Standard Cockpit v0 (npm run endophasia:cockpit). It prints the cockpit URL and runs until
// interrupted; the runtime and the host stop together. Load it with coding-agent's source resolver preloaded.
import { parseArgs } from "node:util";
import { startEndophasiaCockpit } from "./cockpit.ts";

const { values } = parseArgs({
	options: {
		provider: { type: "string" },
		model: { type: "string" },
		directory: { type: "string" },
		port: { type: "string" },
	},
	strict: true,
});

const port = values.port === undefined ? undefined : Number(values.port);
const cockpit = await startEndophasiaCockpit({
	...(values.provider === undefined ? {} : { provider: values.provider }),
	...(values.model === undefined ? {} : { model: values.model }),
	...(values.directory === undefined ? {} : { directory: values.directory }),
	...(port === undefined ? {} : { port }),
	onError: (error) => console.error(`cockpit host: ${error.message}`),
});
console.log(`Endophasia cockpit: ${cockpit.url}`);

let stopping = false;
const stop = (signal: string): void => {
	if (stopping) return;
	stopping = true;
	console.log(`\nStopping Endophasia cockpit (${signal})…`);
	cockpit.close().then(
		() => process.exit(0),
		(error: unknown) => {
			console.error(error);
			process.exit(1);
		},
	);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
await cockpit.closed;
if (!stopping) {
	console.log("Endophasia server stopped.");
	await cockpit.close();
}
