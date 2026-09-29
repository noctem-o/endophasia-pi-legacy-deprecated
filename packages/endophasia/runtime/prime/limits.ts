// Prime RPC Runtime Ingress v0: validation of the numeric options every entry point accepts. A NaN, an Infinity or an
// out-of-range value would otherwise disable a bound silently, or reach a timer that Node coerces to 1 ms.

/** Node's largest timer delay; a longer one is coerced to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A timeout option: an integer number of milliseconds from 0 to MAX_TIMER_MS. Throws RangeError otherwise. */
export function checkTimeout(name: string, value: unknown): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_MS) {
		throw new RangeError(`${name} must be an integer number of milliseconds from 0 to ${MAX_TIMER_MS}`);
	}
}

/** A size bound: a positive safe integer. Throws RangeError otherwise. */
export function checkSize(name: string, value: unknown): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
}
