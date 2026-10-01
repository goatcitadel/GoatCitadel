import { useEffect, useRef, useState } from "react";
import { canonicalJsonString, type McpServerRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../library/session-drafts";
import type { Notice } from "../shared/native-helpers";
import { createEmptyMcpCreateForm } from "./sections/mcp-editor-drafts";
import { prepareMcpCreateInput, type McpCreateInput } from "./mcp-create-binding";
import { commitMcpCreation, useMcpCreationMutation } from "./mcp-create-mutation";

export function useMcpCreation({
  workspaceId,
  active,
  available = true,
  onCreated,
  onNotice,
  onSaveRequest,
}: {
  workspaceId: string;
  active: boolean;
  available?: boolean;
  onCreated: (server: McpServerRecord, clean: boolean) => void;
  onNotice?: (notice: Notice) => void;
  onSaveRequest?: (() => Promise<boolean>) | null;
}) {
  const identity = JSON.stringify([workspaceId, active]);
  const scope = useRef({ identity });
  if (scope.current.identity !== identity) scope.current = { identity };
  const token = scope.current,
    lifetime = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
    };
  }, []);
  const draft = useSessionDraft(`mcp:${workspaceId}:new`, createEmptyMcpCreateForm(), undefined, {
    label: "New MCP server",
    active,
    available,
    onSave: onSaveRequest === null ? undefined : (onSaveRequest ?? (() => save())),
  });
  const generationIdentity = canonicalJsonString([identity, available, draft.value]);
  const generation = useRef({ identity: generationIdentity });
  if (generation.current.identity !== generationIdentity) generation.current = { identity: generationIdentity };
  const mutation = useMcpCreationMutation();
  const [noticeState, setNotice] = useState<{ token: typeof token; notice: Notice } | null>(null);
  const notify = (notice: Notice) => {
    setNotice({ token, notice });
    onNotice?.(notice);
  };
  function reviewInput() {
    if (!active || !available || mutation.locked) return null;
    try {
      return prepareMcpCreateInput(draft.value);
    } catch (error) {
      notify({ tone: "warning", message: describeApiError(error).summary });
      return null;
    }
  }
  async function save(reviewed?: McpCreateInput): Promise<boolean> {
    const input = reviewInput();
    if (!input) return false;
    if (reviewed && canonicalJsonString(reviewed) !== canonicalJsonString(input)) {
      notify({ tone: "warning", message: "The registration draft changed. Review its exact fields again." });
      return false;
    }
    const submitted = draft.value,
      captured = generation.current,
      life = lifetime.current;
    const currentScope = () => mounted.current && lifetime.current === life && scope.current === token;
    const result = await commitMcpCreation(input, () => currentScope() && generation.current === captured);
    if (result.status !== "created") {
      if (currentScope() && generation.current === captured)
        notify({ tone: result.status === "uncertain" ? "error" : "warning", message: result.message });
      return false;
    }
    // The submitted origin draft is acknowledged even after this view leaves.
    // acceptSaved retains any newer typing; view callbacks stay generation-bound.
    const clean = draft.acceptSaved(createEmptyMcpCreateForm(), undefined, submitted);
    if (!currentScope()) return false;
    onCreated(result.server, clean);
    if (generation.current === captured)
      notify({
        tone: "success",
        message: `MCP server ${result.server.label} registered and saved configuration confirmed. No connection or tool call was performed.`,
      });
    return clean;
  }
  return { draft, mutation, reviewInput, save, notice: noticeState?.token === token ? noticeState.notice : null };
}
