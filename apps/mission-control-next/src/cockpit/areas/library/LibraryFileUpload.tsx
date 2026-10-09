import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";

const EMPTY = { path: "", content: "" };
const INPUT = "w-full rounded-md border border-line bg-raised p-2 text-fg";

export function LibraryFileUpload(props: Parameters<typeof LibraryFileUploadContent>[0]) {
 const access = useLibraryOperation(JSON.stringify(["file-upload", props.workspaceId, props.citadelId]));
 return <LibraryFileUploadContent key={access.identity} {...props} />;
}
function LibraryFileUploadContent({ workspaceId, citadelId }: { workspaceId: string; citadelId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["file-upload", workspaceId, citadelId]));
  const client = useQueryClient();
  const draft = useSessionDraft(operation.presentationScope, EMPTY, undefined, { label: "Upload text file" });
  const [review, setReview] = useSessionViewState<typeof EMPTY | undefined>(operation.presentationScope + ":review", undefined);
  const [result, setResult] = useSessionViewState<{ error: boolean; message: string } | undefined>(operation.presentationScope + ":outcome", undefined);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!review || operation.locked || result) return;
    setBusy(true);
    try {
      const receipt = await operation.run(review.path.trim(), async () => review, () => uploadFile(review.path.trim(), review.content), receipt => {
      if (receipt.relativePath !== review.path.trim() || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0) {
        throw new Error("The upload receipt does not match the reviewed target. Refresh the directory to check the result before trying again.");
      }
      });
      if (!receipt) return;
      draft.acceptSaved(EMPTY, undefined, review);
      setResult({ error: false, message: `Gateway accepted ${receipt.relativePath} (${receipt.bytes.toLocaleString()} bytes).` });
      await client.invalidateQueries({ queryKey: ["library", "resources", "files"] });
    } catch (cause) {
      if (operation.current()) setResult({ error: true, message: `${describeApiError(cause).summary} The upload is not confirmed. Your draft is retained; check the directory before retrying.` });
    } finally { setBusy(false); }
  }
  return <>
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium text-fg">Upload text file{draft.isDirty ? " · Unsaved draft" : ""}</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-sm text-fg-secondary">UTF-8 text in the installation shared file root. All workspaces share this destination. Gateway path and size limits apply.</p>
        <Field label="Relative file path">{(props) => <input {...props} className={INPUT} value={draft.value.path} onChange={(event) => draft.setValue({ ...draft.value, path: event.target.value })} />}</Field>
        <Field label="Text content">{(props) => <textarea {...props} className={INPUT} rows={6} value={draft.value.content} onChange={(event) => draft.setValue({ ...draft.value, content: event.target.value })} />}</Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!draft.value.path.trim() || !draft.value.content || busy} onClick={() => { if (operation.locked || !operation.current()) return; setResult(undefined); setReview({ ...draft.value }); }}>Review upload</Button>
          <Button variant="ghost" disabled={busy} onClick={draft.discard}>Discard upload draft</Button>
        </div>
      </div>
    </details>
    <Dialog open={Boolean(review)} onOpenChange={(open) => { if (!open && !busy) setReview(undefined); }} title="Review text file upload" description="Confirm the installation shared destination before writing.">
      <div className="grid gap-3">
        <p className="break-words text-sm text-fg">Target: {review?.path.trim()}</p>
        <Callout tone="warning">This writes a shared file and may replace existing content at this path. The Gateway enforces access and path restrictions.</Callout>
        {result ? <Callout tone={result.error ? "error" : "info"}>{result.message}</Callout> : null}
        {busy ? <p role="status">Uploading text file…</p> : null}
        <Button disabled={busy || operation.locked || Boolean(result)} onClick={() => void submit()}>Upload reviewed text</Button>
      </div>
    </Dialog>
  </>;
}
