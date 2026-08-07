import { useEffect, useRef, useState } from "react";
import type {
  ChatRoutedContextInspection,
  ChatThreadTurnRecord,
  ChatTurnCapabilityProfileEnvelope,
  ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";
import { fetchChatTurnCapabilityProfile } from "@goatcitadel/mission-control-shared/api/client";

export type ChatCapabilityProfileInspectionStatus =
  | "idle"
  | "loading"
  | "verified"
  | "legacy_missing"
  | "invalid"
  | "forbidden"
  | "not_found"
  | "unavailable";

export interface ChatCapabilityProfileInspection {
  status: ChatCapabilityProfileInspectionStatus;
  profile: ChatTurnCapabilityProfileRecord | null;
  routedContext?: ChatRoutedContextInspection;
  expectedProfileId?: string;
  expectedProfileHash?: string;
  mismatchFields: string[];
  message?: string;
}

const IDLE_INSPECTION: ChatCapabilityProfileInspection = {
  status: "idle",
  profile: null,
  mismatchFields: [],
};

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function traceSelectionSignature(turn: ChatThreadTurnRecord | null): string {
  if (!turn) {
    return "";
  }
  const trace = turn.trace;
  const routedContext = trace.routing.routedContext;
  return [
    trace.mode,
    trace.webMode,
    trace.memoryMode,
    trace.thinkingLevel,
    trace.speedMode ?? "",
    trace.subagentPolicy ?? "",
    trace.effectiveToolAutonomy ?? "",
    trace.routing.effectiveProviderId ?? "",
    trace.routing.effectiveModel ?? trace.model ?? "",
    routedContext?.snapshotId ?? "",
    routedContext?.snapshotHash ?? "",
    routedContext?.sourceRequestHash ?? "",
    routedContext?.contentHash ?? "",
  ].join("\u001f");
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

export function useChatCapabilityProfileInspection(input: {
  sessionId: string | null;
  workspaceId: string;
  turn: ChatThreadTurnRecord | null;
}): ChatCapabilityProfileInspection {
  const { sessionId, workspaceId, turn } = input;
  const [inspection, setInspection] = useState<ChatCapabilityProfileInspection>(IDLE_INSPECTION);
  const selectedTurnRef = useRef(turn);
  selectedTurnRef.current = turn;
  const turnId = turn?.turnId;
  const expectedProfileId = turn?.trace.capabilityProfileId;
  const expectedProfileHash = turn?.trace.capabilityProfileHash;
  const selectionSignature = traceSelectionSignature(turn);

  useEffect(() => {
    const selectedTurn = selectedTurnRef.current;
    if (!sessionId || !selectedTurn) {
      setInspection(IDLE_INSPECTION);
      return;
    }
    if (!expectedProfileId && !expectedProfileHash) {
      setInspection({
        status: "legacy_missing",
        profile: null,
        mismatchFields: [],
        message: "This legacy turn has no persisted immutable capability profile.",
      });
      return;
    }
    if (!expectedProfileId || !expectedProfileHash) {
      setInspection({
        status: "invalid",
        profile: null,
        expectedProfileId,
        expectedProfileHash,
        mismatchFields: ["trace profile reference"],
        message: "The turn trace contains an incomplete capability-profile reference.",
      });
      return;
    }

    let stale = false;
    setInspection({
      status: "loading",
      profile: null,
      expectedProfileId,
      expectedProfileHash,
      mismatchFields: [],
    });
    void fetchChatTurnCapabilityProfile(sessionId, selectedTurn.turnId, workspaceId)
      .then((envelope) => {
        if (!stale) {
          setInspection(
            resolveEnvelope({
              envelope,
              sessionId,
              workspaceId,
              turn: selectedTurn,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        if (stale) {
          return;
        }
        const status = readHttpStatus(error);
        if (status === 401 || status === 403) {
          setInspection({
            status: "forbidden",
            profile: null,
            expectedProfileId,
            expectedProfileHash,
            mismatchFields: [],
            message: "This capability profile is outside the current operator or workspace scope.",
          });
          return;
        }
        if (status === 404) {
          setInspection({
            status: "not_found",
            profile: null,
            expectedProfileId,
            expectedProfileHash,
            mismatchFields: [],
            message: "No persisted capability profile is available for this scoped turn.",
          });
          return;
        }
        setInspection({
          status: "unavailable",
          profile: null,
          expectedProfileId,
          expectedProfileHash,
          mismatchFields: [],
          message: "Capability profile inspection is temporarily unavailable.",
        });
      });

    return () => {
      stale = true;
    };
  }, [expectedProfileHash, expectedProfileId, selectionSignature, sessionId, turnId, workspaceId]);

  return inspection;
}
