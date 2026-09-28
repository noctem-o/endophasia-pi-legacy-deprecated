import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type CockpitHost, cockpitContentSecurityPolicy, startCockpitHost } from "../runtime/cockpit-host.ts";

const assets = { html: "<!doctype html><title>shell</title>", js: "console.log(1);", css: "body{}" };
const hosts: CockpitHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
});

async function startHost(port?: number): Promise<CockpitHost> {
	const host = await startCockpitHost({ assets, ...(port === undefined ? {} : { port }) });
	hosts.push(host);
	return host;
}

/** A route under the host's per-launch page path. */
function page(host: CockpitHost, route = ""): string {
	return `${new URL(host.url).pathname}${route}`;
}

interface Response {
	readonly status: number;
	readonly headers: Record<string, string | string[] | undefined>;
	readonly body: string;
}

function send(
	origin: string,
	path: string,
	options: { method?: string; host?: string; address?: string } = {},
): Promise<Response> {
	const url = new URL(origin);
	return new Promise((resolve, reject) => {
		const outgoing = request(
			{
				host: options.address ?? url.hostname,
				port: url.port,
				path,
				method: options.method ?? "GET",
				headers: { host: options.host ?? url.host },
			},
			(incoming) => {
				let body = "";
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk) => {
					body += chunk;
				});
				incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
			},
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}

describe("Standard Cockpit host", () => {
	it("binds 127.0.0.1 only and reports its exact origin", async () => {
		const host = await startHost();
		const origin = new URL(host.origin);
		expect(origin.protocol).toBe("http:");
		expect(origin.hostname).toBe("127.0.0.1");
		expect(host.origin).toBe(origin.origin);

		const external = Object.values(networkInterfaces())
			.flat()
			.find((address) => address !== undefined && !address.internal && address.family === "IPv4");
		if (external !== undefined) {
			await expect(send(host.origin, page(host), { address: external.address })).rejects.toMatchObject({
				code: "ECONNREFUSED",
			});
		}
	});

	it("serves exactly the shell, script, stylesheet and bootstrap", async () => {
		const host = await startHost();
		const shell = await send(host.origin, page(host));
		expect(shell).toMatchObject({ status: 200, body: assets.html });
		expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(await send(host.origin, page(host, "app.js"))).toMatchObject({
			status: 200,
			body: assets.js,
			headers: { "content-type": "text/javascript; charset=utf-8" },
		});
		expect(await send(host.origin, page(host, "app.css"))).toMatchObject({
			status: 200,
			body: assets.css,
			headers: { "content-type": "text/css; charset=utf-8" },
		});
		const head = await send(host.origin, page(host, "app.js"), { method: "HEAD" });
		expect(head).toMatchObject({ status: 200, body: "" });
		expect(head.headers["content-length"]).toBe(String(assets.js.length));
	});

	it("serves a no-store bootstrap with only serverId and websocketUrl once published", async () => {
		const host = await startHost();
		expect((await send(host.origin, page(host, "bootstrap.json"))).status).toBe(503);

		const websocketUrl = "ws://127.0.0.1:4321/pi/capability";
		host.setBootstrap({
			serverId: "00000000-0000-4000-8000-000000000000",
			websocketUrl,
			...({ extra: "not served" } as object),
		});
		const response = await send(host.origin, page(host, "bootstrap.json"));
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(JSON.parse(response.body)).toEqual({ serverId: "00000000-0000-4000-8000-000000000000", websocketUrl });
		expect(response.headers["content-security-policy"]).toBe(cockpitContentSecurityPolicy("ws://127.0.0.1:4321"));
		expect(response.headers["content-security-policy"]).toContain("connect-src 'self' ws://127.0.0.1:4321;");
	});

	it("sends a strict CSP and no CORS headers on every response", async () => {
		const host = await startHost();
		for (const path of [page(host), page(host, "app.js"), page(host, "app.css"), page(host, "bootstrap.json"), "/"]) {
			const response = await send(host.origin, path);
			expect(
				Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
				path,
			).toEqual([]);
			expect(response.headers["cache-control"], path).toBe("no-store");
			expect(response.headers["x-content-type-options"], path).toBe("nosniff");
			const csp = String(response.headers["content-security-policy"]);
			for (const directive of [
				"default-src 'none'",
				"script-src 'self'",
				"style-src 'self'",
				"object-src 'none'",
				"base-uri 'none'",
				"frame-ancestors 'none'",
			]) {
				expect(csp, path).toContain(directive);
			}
			expect(csp, path).not.toContain("unsafe-inline");
		}
	});

	it("refuses any Host other than its loopback authority", async () => {
		const host = await startHost();
		const port = new URL(host.origin).port;
		for (const hostHeader of [
			`localhost:${port}`,
			`evil.test:${port}`,
			"127.0.0.1",
			`127.0.0.1:${Number(port) + 1}`,
		]) {
			expect((await send(host.origin, page(host, "bootstrap.json"), { host: hostHeader })).status, hostHeader).toBe(
				403,
			);
		}
	});

	it("serves nothing outside its unguessable per-launch page path", async () => {
		const host = await startHost();
		const other = await startHost();
		const pagePath = page(host);
		expect(pagePath).toMatch(/^\/c\/[A-Za-z0-9_-]{43}\/$/);
		expect(page(other)).not.toBe(pagePath);
		host.setBootstrap({ serverId: "00000000-0000-4000-8000-000000000000", websocketUrl: "ws://127.0.0.1:4321/pi/x" });
		const wrongToken = `/c/${"A".repeat(43)}/`;
		for (const path of [
			"/",
			"/bootstrap.json",
			"/app.js",
			"/c/",
			pagePath.slice(0, -1),
			`${pagePath.slice(0, -2)}/bootstrap.json`,
			`${wrongToken}bootstrap.json`,
			`${page(other)}bootstrap.json`,
			`${pagePath}bootstrap.json`.toUpperCase(),
		]) {
			const response = await send(host.origin, path);
			expect(response.status, path).toBe(404);
			expect(response.body, path).toBe("");
		}
		expect((await send(host.origin, page(host, "bootstrap.json"))).status).toBe(200);
	});

	it("answers 404 for every other path, including traversal attempts", async () => {
		const host = await startHost();
		for (const path of [
			"/index.html",
			"/app.js?x=1",
			"/bootstrap.json/",
			"/../package.json",
			"/%2e%2e/package.json",
			"/cockpit/main.ts",
			"/api/sessions",
			"/events",
			"//app.js",
			"/constructor",
			"/__proto__",
			page(host, "index.html"),
			page(host, "app.js?x=1"),
			page(host, "../bootstrap.json"),
			page(host, "constructor"),
			page(host, "__proto__"),
		]) {
			const response = await send(host.origin, path);
			expect(response.status, path).toBe(404);
			expect(response.body, path).toBe("");
		}
	});

	it("rejects methods other than GET and HEAD", async () => {
		const host = await startHost();
		for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
			const response = await send(host.origin, page(host, "bootstrap.json"), { method });
			expect(response.status, method).toBe(405);
			expect(response.headers.allow, method).toBe("GET, HEAD");
		}
	});

	it("stops serving on close, idempotently", async () => {
		const host = await startHost();
		const closing = host.close();
		expect(host.close()).toBe(closing);
		await closing;
		await expect(send(host.origin, page(host))).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});

	it("rejects startup on an occupied port without leaking a listener", async () => {
		const first = await startHost();
		const port = Number(new URL(first.origin).port);
		await expect(startCockpitHost({ assets, port })).rejects.toMatchObject({ code: "EADDRINUSE" });
		expect((await send(first.origin, page(first))).status).toBe(200);
		await expect(startCockpitHost({ assets, port: -1 })).rejects.toThrow(TypeError);
	});
});
