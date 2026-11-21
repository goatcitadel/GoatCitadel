import { useEffect, useRef, useState } from "react";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import type {
  ChatRoutedContextInspection,
  ChatThreadTurnRecord,
  ChatTurnCapabilityProfileRecord,
} from "@goatcitadel/contracts";

export type ChatCapabilityProfileInspectionStatus =
  | "idle"
  | "loading"
  | "verified"
  | "admission_verified"
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

function traceSelectionSignature(turn: ChatThreadTurnRecord | null): string {
  if (!turn) {
    return "";
  }
  const trace = turn.trace;
  const routedContext = trace.routing.routedContext;
  return [
    trace.sessionId,
    trace.turnId,
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
    // Session navigation can render the previous turn for one frame before
    // core state clears. Never inspect it through the new session's scope.
    if (
      !sessionId ||
      !selectedTurn ||
      selectedTurn.trace.sessionId !== sessionId ||
      selectedTurn.trace.turnId !== selectedTurn.turnId
    ) {
      setInspection(IDLE_INSPECTION);
      return;
    }
    const profileReferenced = Boolean(expectedProfileId || expectedProfileHash);
    if (!profileReferenced && !selectedTurn.trace.routing.routedContext) {
      setInspection({
        status: "legacy_missing",
        profile: null,
        mismatchFields: [],
        message: "This turn has no persisted capability profile or routed context snapshot.",
      });
      return;
    }

    if (profileReferenced && (!expectedProfileId || !expectedProfileHash)) {
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
    const access = getGatewayAccessRevision();
    const caller = getGatewayCallerScopeRevision();
    const gateway = getGatewayApiBaseUrl();
    const current = () =>
      !stale &&
      getGatewayAccessRevision() === access &&
      getGatewayCallerScopeRevision() === caller &&
      getGatewayApiBaseUrl() === gateway;
    setInspection({
      status: "loading",
      profile: null,
      expectedProfileId,
      expectedProfileHash,
      mismatchFields: [],
      ...(!profileReferenced ? { message: "Checking scoped routed context…" } : {}),
    });
    void import("./chat-capability-profile-inspection")
      .then(async ({ inspectCapabilityProfile }) => {
        if (!current()) return;
        const result = await inspectCapabilityProfile(sessionId, workspaceId, selectedTurn);
        if (current()) setInspection(result);
      })
      .catch(() => {
        if (!current()) return;
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
