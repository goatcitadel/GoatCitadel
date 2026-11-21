import type {
  ChatThreadTurnRecord,
  ChatTurnCapabilityProfileEnvelope,
  ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";
import {
  fetchChatTurnCapabilityProfile,
  fetchChatTurnRoutedContext,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChatCapabilityProfileInspection } from "./useChatCapabilityProfileInspection";

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function verifyChatCapabilityProfileAgainstTurn(input: {
  profile: ChatTurnCapabilityProfileRecord;
  sessionId: string;
  workspaceId: string;
  turn: ChatThreadTurnRecord;
}): string[] {
  const { profile, sessionId, workspaceId, turn } = input;
  const trace = turn.trace;
  const mismatches: string[] = [];
  const expectEqual = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) {
      mismatches.push(label);
    }
  };

  expectEqual("profile id", profile.profileId, trace.capabilityProfileId);
  expectEqual("profile hash", profile.hashes.profileHash, trace.capabilityProfileHash);
  expectEqual("turn identity", profile.identity.turnId, turn.turnId);
  expectEqual("session identity", profile.identity.sessionId, sessionId);
  expectEqual("workspace identity", profile.identity.workspaceId, workspaceId);
  expectEqual("mode", profile.selection.mode, trace.mode);
  expectEqual("web mode", profile.selection.webMode, trace.webMode);
  expectEqual("memory mode", profile.selection.memory.mode, trace.memoryMode);
  expectEqual("memory session", profile.selection.memory.sessionId, sessionId);
  expectEqual("memory workspace", profile.selection.memory.workspaceId, workspaceId);
  expectEqual("thinking level", profile.selection.thinkingLevel, trace.thinkingLevel);

  if (trace.speedMode !== undefined) {
    expectEqual("speed mode", profile.selection.speedMode, trace.speedMode);
  }
  if (trace.subagentPolicy !== undefined) {
    expectEqual("subagent policy", profile.selection.subagentPolicy, trace.subagentPolicy);
  }
  if (trace.effectiveToolAutonomy !== undefined) {
    expectEqual("tool autonomy", profile.selection.toolAutonomy, trace.effectiveToolAutonomy);
  }
  if (trace.routing.effectiveProviderId !== undefined) {
    expectEqual("effective provider", profile.selection.effectiveProviderId, trace.routing.effectiveProviderId);
  }
  const expectedModel = trace.routing.effectiveModel ?? trace.model;
  if (expectedModel !== undefined) {
    expectEqual("effective model", profile.selection.effectiveModel, expectedModel);
  }

  return mismatches;
}

function resolveEnvelope(input: {
  envelope: ChatTurnCapabilityProfileEnvelope;
  sessionId: string;
  workspaceId: string;
  turn: ChatThreadTurnRecord;
}): ChatCapabilityProfileInspection {
  const expectedProfileId = input.turn.trace.capabilityProfileId;
  const expectedProfileHash = input.turn.trace.capabilityProfileHash;
  if (input.envelope.state === "legacy_missing") {
    return {
      status: "legacy_missing",
      profile: null,
      expectedProfileId,
      expectedProfileHash,
      mismatchFields: [],
      message: "This legacy turn has no persisted immutable capability profile.",
    };
  }
  if (input.envelope.state !== "available" || !input.envelope.profile) {
    return {
      status: "invalid",
      profile: null,
      expectedProfileId,
      expectedProfileHash,
      mismatchFields: [],
      message: "The persisted capability profile could not be verified.",
    };
  }

  const mismatchFields = verifyChatCapabilityProfileAgainstTurn({
    profile: input.envelope.profile,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    turn: input.turn,
  });
  const expectedRoutedContext = input.turn.trace.routing.routedContext;
  const persistedRoutedContext = input.envelope.routedContext;
  if (Boolean(expectedRoutedContext) !== Boolean(persistedRoutedContext)) {
    mismatchFields.push("routed context presence");
  } else if (expectedRoutedContext && persistedRoutedContext) {
    const compareRoutedContext = (label: string, actual: unknown, expected: unknown) => {
      if (actual !== expected) {
        mismatchFields.push(label);
      }
    };
    compareRoutedContext(
      "routed context snapshot id",
      persistedRoutedContext.snapshotId,
      expectedRoutedContext.snapshotId,
    );
    compareRoutedContext(
      "routed context snapshot hash",
      persistedRoutedContext.snapshotHash,
      expectedRoutedContext.snapshotHash,
    );
    compareRoutedContext(
      "routed context request hash",
      persistedRoutedContext.sourceRequestHash,
      expectedRoutedContext.sourceRequestHash,
    );
    compareRoutedContext(
      "routed context content hash",
      persistedRoutedContext.contentHash,
      expectedRoutedContext.contentHash,
    );
  }
  if (mismatchFields.length > 0) {
    return {
      status: "invalid",
      profile: null,
      expectedProfileId,
      expectedProfileHash,
      mismatchFields,
      message: "The persisted profile does not exactly match the selected turn trace.",
    };
  }
  return {
    status: "verified",
    profile: input.envelope.profile,
    ...(persistedRoutedContext ? { routedContext: persistedRoutedContext } : {}),
    expectedProfileId,
    expectedProfileHash,
    mismatchFields: [],
    message: persistedRoutedContext
      ? "Profile and routed-context hashes, identity, route, and execution selections match the selected turn."
      : "Profile hash, identity, route, and execution selections match the selected turn.",
  };
}

export async function inspectCapabilityProfile(
  sessionId: string,
  workspaceId: string,
  turn: ChatThreadTurnRecord,
): Promise<ChatCapabilityProfileInspection> {
  const expectedProfileId = turn.trace.capabilityProfileId;
  const expectedProfileHash = turn.trace.capabilityProfileHash;
  if (!expectedProfileId && !expectedProfileHash) {
    const expected = turn.trace.routing.routedContext;
    try {
      const envelope = await fetchChatTurnRoutedContext(sessionId, turn.turnId, workspaceId);
      const actual = envelope.routedContext;
      const mismatchFields =
        envelope.state !== "admission_bound" ||
        envelope.sessionId !== sessionId ||
        envelope.turnId !== turn.turnId ||
        envelope.workspaceId !== workspaceId
          ? ["context scope"]
          : [];
      for (const key of ["snapshotId", "snapshotHash", "sourceRequestHash", "contentHash"] as const) {
        if (!actual || actual[key] !== expected?.[key]) mismatchFields.push(key);
      }
      return mismatchFields.length
        ? {
            status: "invalid",
            profile: null,
            mismatchFields,
            message: "The admitted context does not exactly match the selected turn. Source details remain hidden.",
          }
        : {
            status: "admission_verified",
            profile: null,
            mismatchFields: [],
            routedContext: actual,
            message:
              "Routed context matches the durable admission and selected turn. Current source access was checked.",
          };
    } catch (error) {
      const status = readHttpStatus(error);
      return {
        status: status === 401 || status === 403 ? "forbidden" : status === 404 ? "not_found" : "unavailable",
        profile: null,
        mismatchFields: [],
        message: "Scoped routed context could not be inspected. Current source access may have changed.",
      };
    }
  }

  try {
    const envelope = await fetchChatTurnCapabilityProfile(sessionId, turn.turnId, workspaceId);
    return resolveEnvelope({ envelope, sessionId, workspaceId, turn });
  } catch (error) {
    const status = readHttpStatus(error);
    const base = { profile: null, expectedProfileId, expectedProfileHash, mismatchFields: [] };
    if (status === 401 || status === 403) {
      return {
        ...base,
        status: "forbidden",
        message: "This capability profile is outside the current operator or workspace scope.",
      };
    }
    if (status === 404) {
      return {
        ...base,
        status: "not_found",
        message: "No persisted capability profile is available for this scoped turn.",
      };
    }
    return { ...base, status: "unavailable", message: "Capability profile inspection is temporarily unavailable." };
  }
}
