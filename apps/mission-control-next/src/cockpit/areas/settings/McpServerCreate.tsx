import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type McpServerRecord, type McpServerTemplateRecord } from "@goatcitadel/contracts";
import { getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { fetchMcpTemplates } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useMcpCreation } from "../../../features/native-routes/settings/use-mcp-creation";
import { useMcpTemplateReplacement } from "../../../features/native-routes/settings/use-mcp-template-replacement";
import type { McpCreateInput } from "../../../features/native-routes/settings/mcp-create-binding";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { McpCreateFields } from "./McpCreateFields";
import { McpCreateReview } from "./McpCreateReview";
import { McpOutcomeCheck } from "../../../features/native-routes/settings/McpOutcomeCheck";

export function McpServerCreate({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const client = useQueryClient(),
    leave = useDraftLeave();
  const [reviewed, setReviewed] = useState<McpCreateInput | null>(null),
    [templateLimit, setTemplateLimit] = useState(12);
  const [created, setCreated] = useState<McpServerRecord | null>(null);
  const openedAccess = useRef(getGatewayAccessRevision()).current;
  const templates = useQuery({ queryKey: ["settings", "mcp-templates"], queryFn: fetchMcpTemplates, retry: false });
  const control = useMcpCreation({
    workspaceId,
    active: true,
    onSaveRequest: null,
    onCreated: (server) => {
      setCreated(server);
      client.setQueryData<{ items: McpServerRecord[] }>(["settings", "mcp-servers"], (previous) => ({
        items: [server, ...(previous?.items ?? []).filter((item) => item.serverId !== server.serverId)],
      }));
    },
  });
  const close = () => leave.request(onClose, [control.draft.key]);
  const templateItems = !templates.isError && Array.isArray(templates.data?.items) ? templates.data.items : [];
  const replacement = useMcpTemplateReplacement({ workspaceId, draft: control.draft, templates: templateItems,
    available: !control.mutation.locked && !templates.isFetching && !templates.isError,
    isTemplateCurrent: (template) => {
      const state = client.getQueryState<{ items: McpServerTemplateRecord[] }>(["settings", "mcp-templates"]);
      return state?.status === "success" && state.fetchStatus === "idle"
        && Boolean(state.data?.items.some(item => canonicalJsonString(item) === canonicalJsonString(template)));
    },
  });
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            // Access recovery retains caller-bound input; it cannot open a
            // leave decision for the now-invalid authorization review.
            if (openedAccess !== getGatewayAccessRevision()) onClose();
            else close();
          }
        }}
        title="Register MCP server"
        description="Review a new installation-wide saved configuration. Runtime connections and tool use remain separate governed actions."
      >
        <div className="space-y-4 text-sm text-fg-secondary">
          {control.notice ? (
            <p role={control.notice.tone === "error" ? "alert" : "status"}>{control.notice.message}</p>
          ) : null}
          {control.mutation.message ? <p role="status">{control.mutation.message}</p> : null}
          <McpOutcomeCheck target={{ kind: "create" }} buttonComponent={Button} />
          {created ? (
            <p role="status">
              Saved server ID: <code className="break-all font-mono">{created.serverId}</code>
            </p>
          ) : null}
          {!reviewed ? (
            <>
              <details open>
                <summary>Use an advertised template</summary>
                {templates.isFetching ? <p role="status">Reading templates…</p> : null}
                {templates.isError ? (
                  <p role="alert">Templates unavailable: {describeApiError(templates.error).summary}</p>
                ) : null}
                <ul className="mt-2 space-y-2">
                  {templateItems.slice(0, templateLimit).map((template) => (
                    <li key={template.templateId} className="rounded-md border border-line p-2">
                      <p className="font-semibold text-fg">{template.label}</p>
                      <p className="break-words">{template.description.slice(0, 1200)}</p>
                      <Button
                        size="sm"
                        disabled={control.mutation.locked || templates.isFetching}
                        onClick={() => replacement.request(template)}
                      >
                        Use {template.label} template
                      </Button>
                    </li>
                  ))}
                </ul>
                {templateItems.length > templateLimit ? (
                  <Button size="sm" onClick={() => setTemplateLimit((value) => value + 12)}>
                    Show more templates
                  </Button>
                ) : null}
                <p className="mt-2 text-xs text-fg-muted">
                  Template arguments, authentication references and policy are copied into the draft and included in the
                  review.
                </p>
              </details>
              <McpCreateFields
                draft={control.draft.value}
                disabled={control.mutation.locked}
                onChange={control.draft.setValue}
              />
              <Button
                variant="primary"
                disabled={control.mutation.locked}
                onClick={() => setReviewed(control.reviewInput())}
              >
                Review MCP registration
              </Button>
            </>
          ) : (
            <>
              <McpCreateReview input={reviewed} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={control.mutation.locked}
                  onClick={() => {
                    const input = reviewed;
                    setReviewed(null);
                    void control.save(input);
                  }}
                >
                  Register reviewed MCP server
                </Button>
                <Button disabled={control.mutation.pending} onClick={() => setReviewed(null)}>
                  Cancel registration review
                </Button>
              </div>
            </>
          )}
          <Button onClick={close}>Close registration</Button>
        </div>
      </Dialog>
      <Dialog open={Boolean(replacement.replacement)} onOpenChange={(open) => { if (!open) replacement.cancel(); }}
        title="Replace MCP registration draft?"
        description="Replacing discards the current input and copies the advertised template. Keeping the draft preserves every field.">
        <p className="text-sm text-fg-secondary">Template: {replacement.replacement?.label}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={replacement.cancel}>Keep current draft</Button>
          <Button variant="primary" onClick={replacement.confirm}>Replace draft with template</Button>
        </div>
      </Dialog>
      <McpDraftLeave {...leave.dialogProps} />
    </>
  );
}
