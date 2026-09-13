import { useRef, useState } from "react";
import type { McpElicitationRequest, McpElicitationResponseAction } from "@goatcitadel/contracts";
import { respondMcpElicitation } from "@goatcitadel/mission-control-shared/api/client";
import { CheckCircle2, Square, RotateCcw } from "lucide-react";
import { useSessionDraft } from "../../library/session-drafts";
import { NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import {
  getErrorMessage,
  SettingsActionList,
  SettingsCodeBlock,
  SettingsField,
  SettingsButtonRow,
  type Notice,
} from "../SettingsShared";
import { formatJson, formatMcpElicitationMeta, parseMcpElicitationDraft } from "../../SettingsNativePage";

export function McpElicitationEditor({
  workspaceId,
  request,
  setNotice,
  onResolved,
}: {
  workspaceId: string;
  request: McpElicitationRequest;
  setNotice: (notice: Notice) => void;
  onResolved: () => Promise<void>;
}) {
  const item = request;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const responseDraft = useSessionDraft(
    "mcp:" + workspaceId + ":" + request.elicitationId + ":response",
    "{}",
    undefined,
    { label: "MCP prompt response" },
  );
  const handleElicitationResponse = async (request: McpElicitationRequest, action: McpElicitationResponseAction) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const submitted = responseDraft.value;
    try {
      let content: Record<string, unknown> | undefined;
      if (action === "accept") {
        content = parseMcpElicitationDraft(submitted);
      }
      const updated = await respondMcpElicitation(request.elicitationId, {
        action,
        content,
        owner: { surface: "mcp" },
      });
      setNotice({
        tone: "success",
        message: `MCP elicitation ${updated.status}. Evidence ${
          updated.response?.evidence?.auditEventId ??
          updated.evidence?.statusHistory?.at(-1)?.auditEventId ??
          "recorded"
        }.`,
      });
      const clean = responseDraft.acceptSaved("{}", undefined, submitted);
      if (clean) await onResolved();
    } catch (responseError) {
      setNotice({ tone: "error", message: getErrorMessage(responseError) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={busy} className="mc-next-settings-fieldset">
      <div className="mc-next-settings-panel-body">
        <NativeMetricGrid
          items={[
            { label: "Status", value: item.status, meta: item.elicitationId },
            { label: "Source", value: item.source.sourceType, meta: item.source.serverId ?? "gateway" },
            {
              label: "Prompt",
              value: `${item.prompt.charLength}/${item.prompt.maxChars}`,
              meta: item.prompt.truncated ? "truncated" : "bounded",
            },
            {
              label: "Schema",
              value: `${item.requestedSchema.byteLength}/${item.requestedSchema.maxBytes}`,
              meta:
                item.requestedSchema.redactedSecretCount > 0
                  ? `${item.requestedSchema.redactedSecretCount} redacted`
                  : "bounded",
            },
          ]}
        />
        <SettingsActionList
          ariaLabel={`MCP elicitation ${item.elicitationId}`}
          items={[
            {
              label: item.prompt.text,
              description: formatMcpElicitationMeta(item),
              meta: item.audit.auditEventIds.at(-1) ?? item.createdAt,
            },
          ]}
        />
        <NativeDisclosureCard id={"mcp-response-schema-" + item.elicitationId} title="Requested response schema">
          <SettingsCodeBlock label="Schema">{formatJson(item.requestedSchema.value)}</SettingsCodeBlock>
        </NativeDisclosureCard>
        <SettingsField label="Accept response JSON">
          <textarea
            className="mc-next-settings-textarea"
            rows={4}
            value={responseDraft.value}
            onChange={(event) => responseDraft.setValue(event.target.value)}
          />
        </SettingsField>
        <SettingsButtonRow>
          <NativeButton variant="default" onClick={() => void handleElicitationResponse(item, "accept")}>
            <CheckCircle2 size={16} />
            Accept
          </NativeButton>
          <NativeButton variant="secondary" onClick={() => void handleElicitationResponse(item, "decline")}>
            <Square size={16} />
            Decline
          </NativeButton>
          <NativeButton variant="secondary" onClick={() => void handleElicitationResponse(item, "cancel")}>
            <RotateCcw size={16} />
            Cancel
          </NativeButton>
        </SettingsButtonRow>
      </div>
    </fieldset>
  );
}
