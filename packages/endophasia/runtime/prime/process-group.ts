// Prime RPC Runtime Ingress v0: run a command in a process group this connection owns, and end that group without
// ever signalling a group ID the OS may have reused.
//
// A process-group ID is the leader's PID. Once the leader exited and was reaped, and every other member is gone too,
// the ID is free, and signalling -pgid could reach an unrelated group. So on POSIX the group is led by a small keeper
// process that this module owns: the keeper starts the command in its own group, reports the command's exit, and
// stays alive until it is told to end the group, which it does by SIGKILLing its own group, itself included, in one
// kill(2). While the keeper lives the group ID cannot be reused, so every signal sent to it reaches only this group.
// If this process dies, the keeper sees its control socket close and ends the group the same way.
//
// The boundary is the process group. A descendant that deliberately leaves it (setsid(2), or a Node child spawned with
// `detached: true`) is outside what a process group can contain: once its parent exits it is reparented to init, and
// nothing links it back. Containing such processes needs OS facilities Node does not expose (Linux cgroups or a child
// subreaper, Windows job objects); this module does not claim to.
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

export interface PrimeProcessExitV0 {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** True when the command could not be started at all. */
	readonly spawnFailed: boolean;
}

/**
 * The keeper. It reads one JSON line (command, arguments, environment) from its control socket (fd 3), so none of
 * them appear on a command line, starts the command with the keeper's stdin, stdout and stderr, then points its own
 * copies at /dev/null so the pipes close when the command and its descendants close them. It ignores SIGTERM, SIGINT
 * and SIGHUP, which are meant for the command. If the control socket closes (the owner died), it SIGKILLs the whole
 * group. The owner itself ends the group by SIGKILLing it directly.
 */
const KEEPER = `"use strict";
const { spawn } = require("node:child_process");
const { closeSync, openSync } = require("node:fs");
const { Socket } = require("node:net");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
const control = new Socket({ fd: 3, readable: true, writable: true });
const report = (message) => { try { control.write(JSON.stringify(message) + "\\n"); } catch {} };
const end = () => { try { process.kill(-process.pid, "SIGKILL"); } catch {} process.exit(0); };
let child;
let exited = false;
const exit = (message) => { if (exited) return; exited = true; report({ type: "exit", ...message }); };
const start = (config) => {
	try {
		child = spawn(config.command, config.args, { env: config.env, stdio: [0, 1, 2] });
	} catch {
		exit({ code: null, signal: null, spawnFailed: true });
	}
	for (const fd of [0, 1, 2]) { try { closeSync(fd); openSync("/dev/null", fd === 0 ? "r" : "w"); } catch {} }
	if (child === undefined) return;
	child.on("spawn", () => report({ type: "spawned", pid: child.pid }));
	child.on("error", () => exit({ code: null, signal: null, spawnFailed: true }));
	child.on("exit", (code, signal) => exit({ code, signal, spawnFailed: false }));
};
let buffer = "";
let started = false;
// Decoded as one UTF-8 stream: a character split between two reads must not become U+FFFD.
control.setEncoding("utf8");
control.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!started) { started = true; start(JSON.parse(line)); }
		newline = buffer.indexOf("\\n");
	}
});
control.on("end", end);
control.on("close", end);
control.on("error", end);
`;

/** How long release() waits for the keeper to end the group before SIGKILLing the keeper itself. */
const RELEASE_TIMEOUT_MS = 2_000;

/**
 * A command running in a process group owned by this process. On Windows there are no process groups: the command
 * is spawned directly, group signals go to the command alone, and descendants are not tracked.
 */
export class PrimeProcessGroupV0 {
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	/** Settles once, when the command exits or cannot be started. */
	readonly exited: Promise<PrimeProcessExitV0>;

	readonly #process: ChildProcess;
	readonly #keeper: boolean;
	#alive = true;
	/** Set once this side ends the group (release or killGroup); a keeper exit without it was unexpected. */
	#ending = false;
	#commandPid: number | undefined;
	#released: Promise<void> | undefined;
	#resolveExited!: (exit: PrimeProcessExitV0) => void;
	#exit: PrimeProcessExitV0 | undefined;
	readonly #gone: Promise<void>;

	constructor(
		command: string,
		args: readonly string[],
		options: {
			readonly cwd: string;
			/** The command's complete environment. The keeper itself runs with an empty one. */
			readonly env: Readonly<Record<string, string>>;
			readonly stderr: "pipe" | "ignore";
		},
	) {
		this.exited = new Promise((resolve) => {
			this.#resolveExited = resolve;
		});
		this.#keeper = process.platform !== "win32";
		if (this.#keeper) {
			this.#process = spawn(process.execPath, ["--no-warnings", "-e", KEEPER], {
				cwd: options.cwd,
				env: {},
				stdio: ["pipe", "pipe", options.stderr, "pipe"],
				detached: true,
				windowsHide: true,
			});
			const control = this.#process.stdio[3] as (Readable & Writable) | null | undefined;
			control?.on("error", () => {});
			control?.write(`${JSON.stringify({ command, args: [...args], env: { ...options.env } })}\n`);
			let buffer = "";
			control?.setEncoding("utf8");
			control?.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					this.#onKeeperMessage(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			});
		} else {
			this.#process = spawn(command, [...args], {
				cwd: options.cwd,
				env: { ...options.env },
				stdio: ["pipe", "pipe", options.stderr],
				windowsHide: true,
			});
			this.#process.on("spawn", () => {
				this.#commandPid = this.#process.pid;
			});
			this.#process.on("exit", (code, signal) => this.#settle({ code, signal, spawnFailed: false }));
		}
		this.stdin = this.#process.stdin;
		this.stdout = this.#process.stdout;
		this.stderr = this.#process.stderr;
		this.#gone = new Promise((resolve) => {
			this.#process.on("exit", () => {
				// The keeper died without being told to (it crashed, or something else killed it): the command and its
				// descendants may still run. Handled here, in the callback that observed the exit, while any live member
				// still holds the group ID.
				if (this.#keeper && !this.#ending) this.#killOrphans();
				this.#alive = false;
				// A keeper that ended before reporting (it crashed, or was killed) leaves no exit report.
				this.#settle({ code: null, signal: this.#process.signalCode, spawnFailed: false });
				resolve();
			});
			this.#process.on("error", () => {
				this.#alive = false;
				this.#settle({ code: null, signal: null, spawnFailed: true });
				resolve();
			});
		});
	}

	/** The command's PID, once it started. */
	get pid(): number | undefined {
		return this.#commandPid;
	}

	/** The process-group ID (the keeper's PID) on POSIX; undefined on Windows. */
	get groupId(): number | undefined {
		return this.#keeper ? this.#process.pid : undefined;
	}

	/** Send `signal` to the whole group. The keeper ignores it. A no-op once the group was released. */
	signalGroup(signal: "SIGTERM"): void {
		if (!this.#alive) return;
		try {
			// The keeper is alive, so the group ID is still this group's.
			if (this.#keeper && this.#process.pid !== undefined) process.kill(-this.#process.pid, signal);
			else this.#process.kill(signal);
		} catch {
			// Nothing left to signal.
		}
	}

	/**
	 * SIGKILL the whole group at once, the keeper included, without relying on the keeper to act (it may be stopped or
	 * stuck). Safe while the keeper lives: it is this process's unreaped child, so the group ID is still this group's.
	 * The command's exit is then reported with signal SIGKILL.
	 */
	killGroup(): void {
		if (!this.#alive) return;
		this.#ending = true;
		if (!this.#keeper || this.#process.pid === undefined) {
			this.#process.kill("SIGKILL");
			return;
		}
		try {
			process.kill(-this.#process.pid, "SIGKILL");
		} catch {
			this.#process.kill("SIGKILL");
		}
	}

	/**
	 * Whether a member other than the keeper is still running, from /proc. Zombies do not count: a killed descendant
	 * whose parent exited stays one until init reaps it, which a container's PID 1 may never do. Undefined when it
	 * cannot be known (no /proc, or Windows); false once released.
	 */
	liveMembers(): boolean | undefined {
		const group = this.groupId;
		if (!this.#alive) return false;
		if (group === undefined) return undefined;
		return liveGroupMembers(group);
	}

	/** After an unexpected keeper exit: SIGKILL whatever of the group still runs. */
	#killOrphans(): void {
		const group = this.#process.pid;
		if (group === undefined) return;
		// Only when a live member is seen in /proc: such a member holds the group ID, so it is still this group's. The
		// keeper is already reaped here, so without /proc (non-Linux POSIX) ownership cannot be shown and the ID may have
		// been reused: nothing is signalled, and survivors of an unexpected keeper death are not reached there.
		if (liveGroupMembers(group) !== true) return;
		try {
			process.kill(-group, "SIGKILL");
		} catch {
			// Nothing left.
		}
	}

	/**
	 * SIGKILL everything left in the group, the keeper included, and wait until the keeper is gone. Idempotent. On
	 * Windows it SIGKILLs the command if it still runs.
	 */
	release(): Promise<void> {
		this.#released ??= (async () => {
			if (!this.#alive) return;
			this.#ending = true;
			if (!this.#keeper) {
				// Windows: no group. The command is killed and its exit awaited (bounded), so nothing outlives the release.
				if (this.#exit === undefined) this.#process.kill("SIGKILL");
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					this.#gone,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
					}),
				]);
				clearTimeout(timer);
				return;
			}
			// The whole group, keeper included, is SIGKILLed directly rather than by asking the keeper: the keeper could die
			// or stall between being asked and acting. It is this process's unreaped child until #gone settles, so the
			// group ID is still this group's at this kill.
			this.killGroup();
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				this.#gone,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
				}),
			]);
			clearTimeout(timer);
		})();
		return this.#released;
	}

	#onKeeperMessage(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message === null || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.type === "spawned" && typeof record.pid === "number") this.#commandPid = record.pid;
		if (record.type === "exit") {
			this.#settle({
				code: typeof record.code === "number" ? record.code : null,
				signal: typeof record.signal === "string" ? (record.signal as NodeJS.Signals) : null,
				spawnFailed: record.spawnFailed === true,
			});
		}
	}

	#settle(exit: PrimeProcessExitV0): void {
		if (this.#exit !== undefined) return;
		this.#exit = exit;
		this.#resolveExited(exit);
	}
}

/**
 * Whether process group `group` has a running member other than its leader (the keeper), from /proc. Zombies do not
 * count. Undefined when /proc cannot be read.
 */
function liveGroupMembers(group: number): boolean | undefined {
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!/^[0-9]+$/.test(entry) || Number(entry) === group) continue;
		let stat: string;
		try {
			stat = readFileSync(`/proc/${entry}/stat`, "utf8");
		} catch {
			continue; // The process ended while the directory was read.
		}
		// "pid (comm) state ppid pgrp ...": comm may contain spaces and parentheses, so fields follow the last ")".
		const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		if (Number(pgrp) === group && state !== "Z" && state !== "X") return true;
	}
	return false;
}
