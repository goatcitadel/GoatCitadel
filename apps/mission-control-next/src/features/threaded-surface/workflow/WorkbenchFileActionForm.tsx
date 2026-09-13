import { memo, useEffect, useRef, useState } from "react";
import type {
  ChatSessionWorkbenchFileOperationKind,
  ChatSessionWorkbenchFileOperationRequest,
  ChatSessionWorkbenchFileOperationPreviewRequest,
  ChatSessionWorkbenchFileOperationPreviewResponse,
} from "@goatcitadel/contracts";
import { useIsMounted } from "@next/hooks/use-is-mounted";

/*
 * Owns the file-action form state (operation, paths, notice) so typing a path
 * re-renders this form only, not the whole CodeWorkbenchPanel. Handlers passed
 * in must be referentially stable for the memo() to hold.
 */

const WORKBENCH_FILE_ACTIONS: Array<{ operation: ChatSessionWorkbenchFileOperationKind; label: string }> = [
  { operation: "create_file", label: "Create file" },
  { operation: "create_folder", label: "Create folder" },
  { operation: "rename", label: "Rename" },
  { operation: "delete", label: "Delete" },
  { operation: "duplicate", label: "Duplicate" },
  { operation: "move", label: "Move" },
];

function workbenchFileActionNeedsTarget(operation: ChatSessionWorkbenchFileOperationKind): boolean {
  return operation === "rename" || operation === "duplicate" || operation === "move";
}

function workbenchFileActionPathPlaceholder(operation: ChatSessionWorkbenchFileOperationKind): string {
  if (operation === "create_file") {
    return "src/new-file.ts";
  }
  if (operation === "create_folder") {
    return "src/new-folder";
  }
  return "src/current-file.ts";
}

interface WorkbenchFileActionFormProps {
  busy: boolean;
  repoBlockedReason: string | null;
  selectedFilePath?: string;
  onFileOperationPreview?: (input: ChatSessionWorkbenchFileOperationPreviewRequest) => Promise<ChatSessionWorkbenchFileOperationPreviewResponse | null>;
  onFileOperation?: (input: ChatSessionWorkbenchFileOperationRequest) => Promise<boolean>;
}

export const WorkbenchFileActionForm = memo(function WorkbenchFileActionForm({
  busy,
  repoBlockedReason,
  selectedFilePath,
  onFileOperationPreview,
  onFileOperation,
}: WorkbenchFileActionFormProps) {
  const [operation, setOperation] = useState<ChatSessionWorkbenchFileOperationKind>("create_file");
  const [path, setPath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const [review, setReview] = useState<ChatSessionWorkbenchFileOperationPreviewResponse | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const formRevision = useRef(0);
  const invalidateReview = () => { formRevision.current += 1; setReview(null); setNotice(null); };

  const targetRequired = workbenchFileActionNeedsTarget(operation);
  const blockedReason =
    repoBlockedReason ??
    (!onFileOperation || !onFileOperationPreview ? "File tree operations are unavailable." : null) ??
    (!path.trim() ? "Enter a project-relative path." : null) ??
    (targetRequired && !targetPath.trim() ? "Enter a target path." : null);

  useEffect(() => {
    if (!selectedFilePath || path.trim()) {
      return;
    }
    setPath(selectedFilePath);
    formRevision.current += 1;
    setReview(null);
  }, [path, selectedFilePath]);

  const reviewFileAction = async () => {
    if (blockedReason || busy || pendingRef.current || !onFileOperationPreview) return;
    const revision = formRevision.current;
    const input = { operation, path: path.trim(), targetPath: targetRequired ? targetPath.trim() : undefined };
    pendingRef.current = true; setPending(true); setReview(null); setNotice(null);
    try {
      const result = await onFileOperationPreview(input);
      if (!isMounted() || revision !== formRevision.current) return;
      setReview(result);
      if (!result) setNotice("Unable to review this action. Check the details above and try again.");
    } catch (error) {
      if (isMounted() && revision === formRevision.current) setNotice(error instanceof Error ? error.message : "Unable to review this action.");
    } finally { pendingRef.current = false; if (isMounted()) setPending(false); }
  };

  const runFileAction = async () => {
    if (blockedReason || busy || pendingRef.current || !onFileOperation || !review) return;
    const revision = formRevision.current;
    const input = { ...review.input, expectedRevision: review.revision };
    pendingRef.current = true; setPending(true); setReview(null); setNotice(null);
    try {
      const completed = await onFileOperation(input);
      if (!isMounted() || revision !== formRevision.current) return;
      if (!completed) {
        setNotice("File action was not confirmed. Review the source and destination again before retrying.");
        return;
      }
      const actionLabel = WORKBENCH_FILE_ACTIONS.find((item) => item.operation === operation)?.label;
      setNotice(`${actionLabel} done.`);
      if (operation !== "delete") setPath(input.targetPath ?? input.path);
      if (targetRequired) setTargetPath("");
      formRevision.current += 1;
    } catch (error) {
      if (isMounted() && revision === formRevision.current) setNotice(error instanceof Error ? error.message : "File action was not confirmed. Review again before retrying.");
    } finally { pendingRef.current = false; if (isMounted()) setPending(false); }
  };

  return (
    <div className="mc-next-code-source-form" aria-label="File tree actions">
      <label className="mc-next-code-source-field">
        <span>Action</span>
        <select
          value={operation}
          onChange={(event) => {
            setOperation(event.target.value as ChatSessionWorkbenchFileOperationKind);
            invalidateReview();
          }}
        >
          {WORKBENCH_FILE_ACTIONS.map((item) => (
            <option key={item.operation} value={item.operation}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="mc-next-code-source-field">
        <span>Path</span>
        <input
          value={path}
          placeholder={workbenchFileActionPathPlaceholder(operation)}
          onChange={(event) => {
            setPath(event.target.value);
            invalidateReview();
          }}
        />
      </label>
      {targetRequired ? (
        <label className="mc-next-code-source-field">
          <span>Target</span>
          <input
            value={targetPath}
            placeholder="src/new-name.ts"
            onChange={(event) => {
              setTargetPath(event.target.value);
              invalidateReview();
            }}
          />
        </label>
      ) : null}
      <div className="mc-next-code-source-actions">
        <button
          type="button"
          className="mc-next-panel-button"
          disabled={!selectedFilePath}
          onClick={() => {
            if (selectedFilePath) {
              setPath(selectedFilePath);
              invalidateReview();
            }
          }}
        >
          Use selected
        </button>
        <button
          type="button"
          className="mc-next-panel-button primary"
          disabled={busy || pending || Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          onClick={() => {
            void reviewFileAction();
          }}
        >
          Review file action
        </button>
      </div>
      {review ? (
        <div className="mc-next-code-file-action-review" role="region" aria-label="File action review">
          <p><strong>{WORKBENCH_FILE_ACTIONS.find((item) => item.operation === review.input.operation)?.label}</strong> {review.input.path}
            {review.input.targetPath ? ` → ${review.input.targetPath}` : ""}</p>
          <p>{review.sourceKind === "absent" ? "The new path is currently absent." :
            `${review.affectedPaths.length} existing path${review.affectedPaths.length === 1 ? "" : "s"}; ${review.totalBytes.toLocaleString()} bytes.`}
            {review.input.targetPath ? " The destination is currently absent." : ""}
            {review.input.operation === "delete" ? " Applying this action deletes these files and folders." : ""}</p>
          {review.affectedPaths.length > 0 ? <details><summary>Review affected paths ({review.affectedPaths.length})</summary>
            <ul>{review.affectedPaths.map((entry) => <li key={entry.path}>{entry.path}{entry.kind === "directory" ? "/" : ""}</li>)}</ul>
          </details> : null}
          <button type="button" className="mc-next-panel-button primary" disabled={busy || pending || Boolean(blockedReason)}
            onClick={() => { void runFileAction(); }}>Apply reviewed action</button>
        </div>
      ) : null}
      {notice ? <p className="mc-next-workbench-empty" role="status">{notice}</p> : null}
    </div>
  );
});
