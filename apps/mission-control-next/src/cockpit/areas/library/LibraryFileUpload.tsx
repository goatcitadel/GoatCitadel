import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFilesList, uploadFile } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { formatAbsoluteTime, formatBytes } from "@goatcitadel/mission-control-shared/content/format";

const EMPTY = { path: "", content: "" };
const INPUT = "w-full rounded-md border border-line bg-raised p-2 text-fg";
const LOOKUP_LIMIT = 1000;

/** The file list is relative to the listed directory, so the reviewed path splits into that directory and a name. */
function splitUploadPath(path: string) {
  const normalized = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "");
  const slash = normalized.lastIndexOf("/");
  return { dir: slash > 0 ? normalized.slice(0, slash) : ".", name: normalized.slice(slash + 1) };
}

export function LibraryFileUpload(props: Parameters<typeof LibraryFileUploadContent>[0]) {
  const access = useLibraryOperation(JSON.stringify(["file-upload", props.workspaceId, props.citadelId]));
  return <LibraryFileUploadContent key={access.identity} {...props} />;
}
function LibraryFileUploadContent({ workspaceId, citadelId }: { workspaceId: string; citadelId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["file-upload", workspaceId, citadelId]));
  const client = useQueryClient();
  const draft = useSessionDraft(operation.presentationScope, EMPTY, undefined, { label: "Upload text file" });
  const [review, setReview] = useSessionViewState<typeof EMPTY | undefined>(
    operation.presentationScope + ":review",
    undefined,
  );
  const [result, setResult] = useSessionViewState<{ error: boolean; message: string } | undefined>(
    operation.presentationScope + ":outcome",
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const target = review ? splitUploadPath(review.path) : undefined;
  // A truncated listing cannot prove absence, so it reads as a failed check rather than a new file.
  const existing = useQuery({
    queryKey: ["library", "file-upload-target", target?.dir, target?.name],
    enabled: Boolean(target?.name),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { items } = await fetchFilesList(target!.dir, LOOKUP_LIMIT);
      // Windows filesystems ignore case, so a case-only match still counts as a replacement.
      const name = target!.name.toLowerCase();
      const match = items.find((file) => file.relativePath.toLowerCase() === name);
      if (!match && items.length >= LOOKUP_LIMIT) throw new Error("The directory listing was truncated.");
      return match ?? null;
    },
  });
  const checking = Boolean(target?.name) && existing.isPending;
  const replaces = existing.data
    ? `This replaces ${existing.data.relativePath} (${formatBytes(existing.data.size)}, modified ${formatAbsoluteTime(existing.data.modifiedAt)}).`
    : undefined;
  async function submit() {
    if (!review || operation.locked || result) return;
    setBusy(true);
    try {
      const receipt = await operation.run(
        review.path.trim(),
        async () => review,
        // A checked "new file" upload asks the Gateway to refuse the write if a file appeared since the review.
        () => uploadFile(review.path.trim(), review.content, { expectAbsent: existing.data === null }),
        (receipt) => {
          if (
            receipt.relativePath !== review.path.trim() ||
            !Number.isSafeInteger(receipt.bytes) ||
            receipt.bytes < 0
          ) {
            throw new Error(
              "The upload receipt does not match the reviewed target. Refresh the directory to check the result before trying again.",
            );
          }
        },
      );
      if (!receipt) return;
      draft.acceptSaved(EMPTY, undefined, review);
      setResult({
        error: false,
        message: `Gateway accepted ${receipt.relativePath} (${formatBytes(receipt.bytes)}).`,
      });
      await client.invalidateQueries({ queryKey: ["library", "resources", "files"] });
    } catch (cause) {
      // The operation runner wraps the Gateway error; its cause says whether a file appeared since the review.
      const ownerError = cause instanceof Error && cause.cause !== undefined ? cause.cause : cause;
      if (operation.current() && describeApiError(ownerError).category === "conflict") {
        setResult({
          error: true,
          message:
            "A file now exists at this path, so nothing was written. Your draft is retained; close and review the upload again to replace it.",
        });
        void existing.refetch();
      } else if (operation.current())
        setResult({
          error: true,
          message: `${describeApiError(cause).summary} The upload is not confirmed. Your draft is retained; check the directory before retrying.`,
        });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {operation.locked && operation.attempt?.message ? (
        <Callout tone="warning">{operation.attempt.message}</Callout>
      ) : null}
      <details className="border-t border-line-subtle pt-4">
        <summary className="cursor-pointer text-sm font-medium text-fg">
          Upload text file{draft.isDirty ? " · Unsaved draft" : ""}
        </summary>
        <div className="mt-3 grid gap-3">
          <p className="text-sm text-fg-secondary">
            UTF-8 text in the installation shared file root. All workspaces share this destination. Gateway path and
            size limits apply.
          </p>
          <Field label="Relative file path">
            {(props) => (
              <input
                {...props}
                className={INPUT}
                value={draft.value.path}
                onChange={(event) => draft.setValue({ ...draft.value, path: event.target.value })}
              />
            )}
          </Field>
          <Field label="Text content">
            {(props) => (
              <textarea
                {...props}
                className={INPUT}
                rows={6}
                value={draft.value.content}
                onChange={(event) => draft.setValue({ ...draft.value, content: event.target.value })}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!draft.value.path.trim() || !draft.value.content || busy}
              onClick={() => {
                if (operation.locked || !operation.current()) return;
                setResult(undefined);
                setReview({ ...draft.value });
              }}
            >
              Review upload
            </Button>
            <Button variant="ghost" disabled={busy} onClick={draft.discard}>
              Discard upload draft
            </Button>
          </div>
        </div>
      </details>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !busy) setReview(undefined);
        }}
        title="Review text file upload"
        description="Confirm the installation shared destination before writing."
      >
        <div className="grid gap-3">
          <p className="break-words text-sm text-fg">Target: {review?.path.trim()}</p>
          {checking ? (
            <p role="status" className="text-sm text-fg-secondary">
              Checking whether a file already exists at this path…
            </p>
          ) : replaces ? (
            <Callout tone="warning">{replaces} The Gateway enforces access and path restrictions.</Callout>
          ) : existing.data === null ? null : (
            <Callout tone="warning">
              {existing.isError ? "The file check could not run. " : ""}This writes a shared file and may replace
              existing content at this path. The Gateway enforces access and path restrictions.
            </Callout>
          )}
          {result ? <Callout tone={result.error ? "error" : "info"}>{result.message}</Callout> : null}
          {busy ? <p role="status">Uploading text file…</p> : null}
          <Button
            variant={existing.data === null ? "primary" : "danger"}
            loading={checking}
            loadingLabel="Checking file…"
            disabled={busy || operation.locked || Boolean(result)}
            onClick={() => void submit()}
          >
            {replaces ? "Replace file" : existing.data === null ? "Upload file" : "Upload or replace file"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
