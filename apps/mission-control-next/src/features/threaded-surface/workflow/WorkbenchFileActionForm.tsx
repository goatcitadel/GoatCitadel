import { memo, useEffect, useState } from "react";
import type {
  ChatSessionWorkbenchFileOperationKind,
  ChatSessionWorkbenchFileOperationRequest,
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
  onFileOperation?: (input: ChatSessionWorkbenchFileOperationRequest) => Promise<boolean>;
}

export const WorkbenchFileActionForm = memo(function WorkbenchFileActionForm({
  busy,
  repoBlockedReason,
  selectedFilePath,
  onFileOperation,
}: WorkbenchFileActionFormProps) {
  const [operation, setOperation] = useState<ChatSessionWorkbenchFileOperationKind>("create_file");
  const [path, setPath] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const targetRequired = workbenchFileActionNeedsTarget(operation);
  const blockedReason =
    repoBlockedReason ??
    (!onFileOperation ? "File tree operations are unavailable." : null) ??
    (!path.trim() ? "Enter a project-relative path." : null) ??
    (targetRequired && !targetPath.trim() ? "Enter a target path." : null);

  useEffect(() => {
    if (!selectedFilePath || path.trim()) {
      return;
    }
    setPath(selectedFilePath);
  }, [path, selectedFilePath]);

  const runFileAction = async () => {
    if (blockedReason || busy || !onFileOperation) {
      return;
    }
    const input: ChatSessionWorkbenchFileOperationRequest = {
      operation,
      path: path.trim(),
      targetPath: targetRequired ? targetPath.trim() : undefined,
    };
    let completed: boolean | void;
    try {
      completed = await onFileOperation(input);
    } catch (error) {
      if (!isMounted()) {
        return;
      }
      setNotice(error instanceof Error ? `File action failed: ${error.message}` : "File action failed.");
      return;
    }
    if (!isMounted()) {
      return;
    }
    if (completed === false) {
      setNotice("File action failed.");
      return;
    }
    const actionLabel = WORKBENCH_FILE_ACTIONS.find((item) => item.operation === operation)?.label;
    setNotice(`${actionLabel} done.`);
    if (operation !== "delete") {
      setPath(targetRequired ? targetPath.trim() : path.trim());
    }
    if (targetRequired) {
      setTargetPath("");
    }
  };

  return (
    <div className="mc-next-code-source-form" aria-label="File tree actions">
      <label className="mc-next-code-source-field">
        <span>Action</span>
        <select
          value={operation}
          onChange={(event) => {
            setOperation(event.target.value as ChatSessionWorkbenchFileOperationKind);
            setNotice(null);
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
            setNotice(null);
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
              setNotice(null);
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
              setNotice(null);
            }
          }}
        >
          Use selected
        </button>
        <button
          type="button"
          className="mc-next-panel-button primary"
          disabled={busy || Boolean(blockedReason)}
          title={blockedReason ?? undefined}
          onClick={() => {
            void runFileAction();
          }}
        >
          Run action
        </button>
      </div>
      {notice ? <p className="mc-next-workbench-empty">{notice}</p> : null}
    </div>
  );
});
