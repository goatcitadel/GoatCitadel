import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchMcpTemplates } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useMcpCreation } from "../../../features/native-routes/settings/use-mcp-creation";
import { createMcpFormFromTemplate } from "../../../features/native-routes/settings/sections/mcp-editor-drafts";
import type { McpCreateInput } from "../../../features/native-routes/settings/mcp-create-binding";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { McpCreateFields } from "./McpCreateFields";
import { McpCreateReview } from "./McpCreateReview";

export function McpServerCreate({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const client = useQueryClient(),
    leave = useDraftLeave();
  const [reviewed, setReviewed] = useState<McpCreateInput | null>(null),
    [templateLimit, setTemplateLimit] = useState(12);
  const [created, setCreated] = useState<McpServerRecord | null>(null);
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
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Register MCP server"
        description="Review a new installation-wide saved configuration. Runtime connections and tool use remain separate governed actions."
      >
        <div className="space-y-4 text-sm text-fg-secondary">
          {control.notice ? (
            <p role={control.notice.tone === "error" ? "alert" : "status"}>{control.notice.message}</p>
          ) : null}
          {control.mutation.message ? <p role="status">{control.mutation.message}</p> : null}
          {created ? (
            <p role="status">
              Saved server ID: <code className="break-all font-mono">{created.serverId}</code>
            </p>
          ) : null}
          {!reviewed ? (
            <>
              <McpCreateFields
                draft={control.draft.value}
                disabled={control.mutation.locked}
                onChange={control.draft.setValue}
              />
              <details>
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
                        onClick={() => control.draft.setValue(createMcpFormFromTemplate(template))}
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
      <McpDraftLeave {...leave.dialogProps} />
    </>
  );
}
