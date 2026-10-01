/** Study-declared order, never filesystem or capture order. No predicates or classifications live here. */
export function orderScenarios<T>(runs: readonly T[], declared: readonly string[], id: (run: T) => string): T[] {
	if (!declared.length || declared.some((name) => typeof name !== "string" || !name.length))
		throw new Error("scenario IDs required");
	const names = runs.map(id);
	if (
		new Set(declared).size !== declared.length ||
		new Set(names).size !== names.length ||
		names.length !== declared.length ||
		names.some((name) => !declared.includes(name))
	)
		throw new Error("scenario set must be complete and unique");
	const byId = new Map(runs.map((run, i) => [names[i]!, run]));
	return declared.map((name) => byId.get(name)!);
}
