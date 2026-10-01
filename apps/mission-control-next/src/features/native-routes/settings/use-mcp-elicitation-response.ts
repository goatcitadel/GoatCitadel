import { useLayoutEffect, useRef } from "react";
import {
  canonicalJsonString,
  type McpElicitationRequest,
  type McpElicitationResponseAction,
} from "@goatcitadel/contracts";
import { useSessionDraft } from "../library/session-drafts";
import { commitMcpElicitationResponse, mcpElicitationBinding, useMcpResponseAttempt } from "./mcp-elicitation-response";
import { mcpElicitationFields } from "./mcp-elicitation-fields";

export function useMcpElicitationResponse({
  request,
  workspaceId,
  onRecorded,
}: {
  request: McpElicitationRequest;
  workspaceId: string;
  onRecorded?: () => void | Promise<void>;
}) {
  const identity = JSON.stringify([workspaceId, mcpElicitationBinding(request)]);
  const live = useRef({ identity, generation: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation += 1;
  }
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.generation += 1;
    };
  }, []);
  const draft = useSessionDraft<Record<string, string>>(
    `mcp:${request.elicitationId}:structured-response`,
    {},
    identity,
    { label: "MCP response", active: request.status === "pending" },
  );
  const attempt = useMcpResponseAttempt(request.elicitationId);
  const draftIdentity = canonicalJsonString(draft.value),
    draftLive = useRef(draftIdentity);
  draftLive.current = draftIdentity;
  const fields = mcpElicitationFields(request);
  const ownerMatches = !request.owner.workspaceId || request.owner.workspaceId === workspaceId;
  async function respond(action: McpElicitationResponseAction) {
    const generation = live.current.generation,
      submitted = { ...draft.value };
    const current = () =>
      live.current.mounted && live.current.identity === identity && live.current.generation === generation;
    const receipt = await commitMcpElicitationResponse({
      request,
      action,
      values: submitted,
      workspaceId,
      isCurrent: () => current() && draftLive.current === draftIdentity,
    });
    if (!receipt) return;
    draft.acceptSaved({}, identity, submitted);
    if (current()) {
      try {
        await onRecorded?.();
      } catch {
        /* Confirmed response remains recorded; the read owner presents refresh failures. */
      }
    }
  }
  return {
    draft,
    attempt,
    fields,
    respond,
    available: ownerMatches && request.status === "pending" && !attempt.locked,
  };
}
