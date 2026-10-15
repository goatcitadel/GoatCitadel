import { useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileFromTemplate,
  fetchFileTemplates,
  type FileTemplate,
} from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import {
  getGatewayCallerScopeRevision,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useLibraryOperation } from "./use-library-operation";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";
import { formatBytes } from "@goatcitadel/mission-control-shared/content/format";

const EMPTY = { templateId: "", path: "" };
const INPUT = "w-full rounded-md border border-line bg-raised p-2 text-fg";
const sameTemplate = (left: FileTemplate, right: FileTemplate) =>
  (["templateId", "title", "description", "defaultPath", "body"] as const).every((key) => left[key] === right[key]);

export function LibraryFileTemplates(props: { workspaceId: string; citadelId: string }) {
  const access = useLibraryOperation(JSON.stringify(["file-template", props.workspaceId, props.citadelId]));
  const callerRevision = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, () => 0);
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  // The view is current-access scoped; the existing draft/attempt keys remain stable across caller revisions.
  return (
    <LibraryFileTemplatesContent
      key={access.identity + ":" + callerRevision + ":" + history}
      {...props}
      callerRevision={callerRevision}
      history={history}
    />
  );
}
function LibraryFileTemplatesContent({
  workspaceId,
  citadelId,
  callerRevision,
  history,
}: {
  workspaceId: string;
  citadelId: string;
  callerRevision: number;
  history: string;
}) {
  const operation = useLibraryOperation(JSON.stringify(["file-template", workspaceId, citadelId]));
  const client = useQueryClient();
  const location = useCockpitRoute();
  const recoveryParameters = new URLSearchParams(location.search);
  recoveryParameters.set("workspaceId", workspaceId);
  recoveryParameters.set("citadelId", citadelId);
  recoveryParameters.delete("shell");
  recoveryParameters.delete("shellScope");
  const recoveryHref = "/library/files?" + recoveryParameters + location.hash;
  const [open, setOpen] = useState(false);
  const draft = useSessionDraft(operation.presentationScope, EMPTY, undefined, {
    label: "File from template",
    active: open,
  });
  const [review, setReview] = useState<{ template: FileTemplate; path: string; draft: typeof EMPTY; ticket: symbol }>();
  const ticket = useRef<symbol | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error: boolean; message: string }>();
  const current = () =>
    operation.current() && getGatewayCallerScopeRevision() === callerRevision && readCockpitHistory() === history;
  const templates = useQuery({
    queryKey: ["library", "file-templates", operation.identity, callerRevision],
    queryFn: () => fetchFileTemplates(),
    enabled: open,
    staleTime: 0,
  });
  const selected =
    templates.data?.items.find((item) => item.templateId === draft.value.templateId) ??
    (!draft.value.templateId ? templates.data?.items[0] : undefined);
  const available = templates.isSuccess && !templates.isError && !templates.isFetching && Boolean(selected);
  function closeReview() {
    ticket.current = undefined;
    setReview(undefined);
    setResult(undefined);
  }
  function edit(value: typeof EMPTY) {
    closeReview();
    draft.setValue(value);
  }
  async function create() {
    if (!review || busy || operation.locked || !current() || result) return;
    const submitted = review;
    const intentCurrent = () => current() && ticket.current === submitted.ticket;
    setBusy(true);
    try {
      const receipt = await operation.run(
        submitted.template.templateId,
        async () => {
          const fresh = await fetchFileTemplates();
          const canonical = fresh.items.find((item) => item.templateId === submitted.template.templateId);
          if (!canonical || !sameTemplate(canonical, submitted.template))
            throw new Error(
              "The template changed or is unavailable. Close this review and refresh templates before creating a file.",
            );
          return canonical;
        },
        () => createFileFromTemplate(submitted.template.templateId, submitted.path),
        (receipt) => {
          if (receipt.relativePath !== submitted.path || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0)
            throw new Error(
              "The creation receipt does not match the reviewed path. Inspect files before trying again.",
            );
        },
        false,
        intentCurrent,
      );
      if (!receipt || !intentCurrent()) return;
      draft.acceptSaved(EMPTY, undefined, submitted.draft);
      setResult({
        error: false,
        message: `Gateway accepted ${receipt.relativePath} (${formatBytes(receipt.bytes)}).`,
      });
      await client.invalidateQueries({ queryKey: ["library", "resources", "files"] });
    } catch (cause) {
      if (intentCurrent())
        setResult({
          error: true,
          message: `${describeApiError(cause).summary} Your draft is retained. Inspect the file directory before retrying an unconfirmed creation.`,
        });
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create from template</Button>
      {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
      {open ? (
        <section aria-label="File from template" className="grid gap-3 rounded-lg border border-line p-3">
          <p className="text-sm text-fg-secondary">
            Create a text file in the installation shared file root. All workspaces share this destination. Gateway
            access and path restrictions apply.
          </p>
          {templates.isPending ? <p role="status">Loading file templates…</p> : null}
          {templates.isError ? (
            <Callout tone="error">Templates unavailable. {describeApiError(templates.error).summary}</Callout>
          ) : null}
          {templates.isSuccess && !templates.data.items.length ? (
            <p role="status">No file templates were returned.</p>
          ) : null}
          <Field label="File template">
            {(props) => (
              <select
                {...props}
                className={INPUT}
                value={selected?.templateId ?? ""}
                disabled={!available || operation.locked || busy}
                onChange={(event) => edit({ ...draft.value, templateId: event.target.value })}
              >
                {templates.data?.items.map((item) => (
                  <option key={item.templateId} value={item.templateId}>
                    {item.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {selected ? <p className="text-sm text-fg-secondary">{selected.description}</p> : null}
          <Field label="Relative file path">
            {(props) => (
              <input
                {...props}
                className={INPUT}
                value={draft.value.path}
                placeholder={selected?.defaultPath ?? ""}
                disabled={operation.locked || busy}
                onChange={(event) => edit({ ...draft.value, path: event.target.value })}
              />
            )}
          </Field>
          {selected ? (
            <p className="text-xs text-fg-secondary">
              Leave the path empty to use the Gateway's current template path: {selected.defaultPath}.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!available || operation.locked || busy}
              onClick={() => {
                if (!selected || !current() || operation.locked) return;
                const intent = Symbol();
                ticket.current = intent;
                setResult(undefined);
                setReview({
                  template: { ...selected },
                  path: draft.value.path.trim() || selected.defaultPath,
                  draft: { ...draft.value },
                  ticket: intent,
                });
              }}
            >
              Review template file
            </Button>
            <Button
              variant="ghost"
              disabled={busy || operation.locked}
              onClick={() => {
                closeReview();
                draft.discard();
              }}
            >
              Discard template draft
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                closeReview();
                setOpen(false);
              }}
            >
              Close template editor
            </Button>
            <Button
              variant="ghost"
              disabled={templates.isFetching || busy}
              onClick={() => {
                closeReview();
                void templates.refetch();
              }}
            >
              Refresh templates
            </Button>
          </div>
          {operation.locked ? (
            <NativeOwnerLink href={recoveryHref} scope={operation.presentationScope}>
              Inspect current files
            </NativeOwnerLink>
          ) : null}
        </section>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(value) => {
          if (!value && !busy) closeReview();
        }}
        title="Review file creation"
        description="Confirm the shared destination before writing a template file."
      >
        <div className="grid gap-3">
          <p className="text-sm text-fg">Template: {review?.template.title}</p>
          <p className="break-words text-sm text-fg">Target: {review?.path}</p>
          <Callout tone="warning">
            This writes an installation shared file and may replace existing content at this path. Cancel makes no
            request.
          </Callout>
          {result ? <Callout tone={result.error ? "error" : "info"}>{result.message}</Callout> : null}
          {busy ? <p role="status">Checking the current template and creating the reviewed file…</p> : null}
          <Button disabled={busy || operation.locked || Boolean(result)} onClick={() => void create()}>
            Create reviewed file
          </Button>
          <Button variant="ghost" disabled={busy} onClick={closeReview}>
            Cancel creation
          </Button>
        </div>
      </Dialog>
    </>
  );
}
