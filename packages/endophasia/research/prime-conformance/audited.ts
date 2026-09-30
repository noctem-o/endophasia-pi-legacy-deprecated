// Research coordinates, never a Runtime Profile or production attestation.
import type { PrimeProvenanceV0 } from "./evidence.ts";

export const PRIME_097 = { version: "0.9.7", commit: "08ff1b2e2794ea9e8f4a08d12bc95408a66e1074" } as const;
export const AUDITED_PROFILES = [
	{ version: "0.9.6", commit: "2d24ad4e6b2d1ee8e6919af6f108e980a14d550e", probeVersion: "0.13.0" },
	{ ...PRIME_097, probeVersion: "0.14.1" },
] as const;

export function auditedProvenance(provenance: PrimeProvenanceV0 | undefined): boolean {
	if (provenance === undefined) return false;
	return (
		provenance.mode === "rpc" &&
		provenance.build === "clean-checkout" &&
		(provenance.version !== PRIME_097.version ||
			(provenance.endophasiaBuild === "clean-checkout" &&
				[provenance.artifactsHash, provenance.launcherHash, provenance.lockHash, provenance.researchHash].every(
					(value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
				))) &&
		AUDITED_PROFILES.some(
			(profile) =>
				profile.version === provenance.version &&
				profile.commit === provenance.commit &&
				profile.probeVersion === provenance.probeVersion,
		)
	);
}

// Re-read at 08ff1b2e. All paths are relative to upstream packages/coding-agent unless otherwise stated.
export const PRIME_097_SOURCE = {
	rpcCommands: "prime@08ff1b2e:packages/coding-agent/src/modes/daemon/daemon-protocol.ts:19-238 (command table)",
	rpcEvents: "prime@08ff1b2e:packages/agent/src/types.ts:390-433 (AgentEvent; no operation/run/turn IDs)",
	sessionFormat:
		"prime@08ff1b2e:packages/coding-agent/src/core/session-manager.ts:54-167,418-433 (tree and child attribution)",
	agentEndPaths: "prime@08ff1b2e:packages/agent/src/agent-loop.ts:310-449,751-756 (loop, tool termination, stops)",
	sessionStats:
		"prime@08ff1b2e:packages/coding-agent/src/core/agent-session.ts:14776-14824 (current messages, recomputed total)",
	childUsage:
		"prime@08ff1b2e:packages/coding-agent/src/core/agent-session.ts:1507-1516 (parent context total retained)",
	retrySlice: "prime@08ff1b2e:packages/coding-agent/src/core/agent-session.ts:13434-13444 (failed message removed)",
	requestAbort: "prime@08ff1b2e:packages/coding-agent/src/core/agent-session.ts:8199-8206 (queue suspension)",
	compactAborts: "prime@08ff1b2e:packages/coding-agent/src/core/agent-session.ts:8718-8725 (compact aborts first)",
	promptResume: "prime@08ff1b2e:packages/coding-agent/src/modes/daemon/daemon-mode.ts:4465-4553 (prompt admission)",
	compactionUsage:
		"prime@08ff1b2e:packages/coding-agent/src/core/compaction/compaction.ts:108-116,829-866 (summary accounting)",
	openAiUsage: "prime@08ff1b2e:packages/ai/src/providers/openai-completions.ts:1110-1178 (usage mapping)",
	sessionRewrite:
		"prime@08ff1b2e:packages/coding-agent/src/core/session-manager.ts:1780-1794,1893-1911,2544-2615 (rewrite/fork)",
	autoRefine:
		"prime@08ff1b2e:packages/coding-agent/src/core/settings-manager.ts:1030-1045;core/agent-session.ts:3398-3428 (default-on review)",
	rlmChildren: "prime@08ff1b2e:packages/coding-agent/docs/rlm.md:64-118 (separate child sessions)",
} as const;
