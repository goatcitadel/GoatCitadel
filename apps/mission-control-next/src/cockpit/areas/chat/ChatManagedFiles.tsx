import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatApprovalMode,
  ManagedProjectFilePublishRequest,
  ManagedProjectFileRevision,
} from "@goatcitadel/contracts";
import {
  chatApprovalModeQueryKey,
  downloadChatManagedFile,
  fetchChatApprovalMode,
  fetchChatManagedFiles,
  publishChatManagedFile,
  restoreChatManagedFile,
  updateChatApprovalMode,
} from "@goatcitadel/mission-control-shared/api/chat-managed-files";
import {
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayCallerScopeRevision,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { ManagedFileOverwriteReview } from "./ManagedFileOverwriteReview";

interface ManagedFilesProps {
  sessionId: string;
  workspaceId: string;
  projectId: string;
  projectName?: string;
  turnId?: string;
  turnActive: boolean;
  canMutate: boolean;
  sendError?: string | null;
}

export function ChatManagedFiles(props: ManagedFilesProps) {
  // Subscribe to both custody sources so a scoped request is cancelled on a caller change.
  useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScopeRevision, () => 0);
  const scope = chatApprovalModeQueryKey(props.workspaceId, props.sessionId, props.projectId)[1];
  return <ManagedFilesControls key={scope} scope={scope} {...props} />;
}

function ManagedFilesControls({
  scope,
  sessionId,
  workspaceId,
  projectId,
  projectName,
  turnId,
  turnActive,
  canMutate,
  sendError,
}: ManagedFilesProps & { scope: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pending, setPending] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [overwriteReview, setOverwriteReview] = useState<ManagedProjectFilePublishRequest>();
  const attempt = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      attempt.current?.abort();
      attempt.current = null;
    },
    [],
  );

  const modeKey = ["chat-approval-mode", scope] as const;
  const modeQuery = useQuery({
    queryKey: modeKey,
    queryFn: ({ signal }) => fetchChatApprovalMode(sessionId, signal),
    refetchOnMount: "always",
    retry: false,
  });
  const state = modeQuery.data;
  const current = state?.autoAvailable && state.workspaceId === workspaceId && state.projectId === projectId;
  const auto = current && state.mode === "auto" && !modeQuery.isError;
  const filesKey = ["chat-managed-files", scope, state?.modeRevision, prefix] as const;
  const files = useQuery({
    queryKey: filesKey,
    queryFn: ({ signal }) => fetchChatManagedFiles(sessionId, { prefix, signal }),
    enabled: open && Boolean(auto),
    retry: false,
  });
  useEffect(() => {
    if (open && auto) void queryClient.invalidateQueries({ queryKey: ["chat-managed-files", scope] });
  }, [queryClient, scope, open, auto, turnId, turnActive]);
  useEffect(() => {
    if (sendError?.includes("Chat approval mode or project changed")) {
      void queryClient.invalidateQueries({ queryKey: ["chat-approval-mode", scope] });
    }
  }, [queryClient, scope, sendError]);

  if (!current) return null;

  function run(label: string, failure: string, work: (signal: AbortSignal) => Promise<string | undefined>) {
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setPending(label);
    setStatus(undefined);
    setError(undefined);
    void (async () => {
      try {
        const message = await work(controller.signal);
        if (!controller.signal.aborted) setStatus(message);
      } catch {
        if (!controller.signal.aborted) setError(failure);
      } finally {
        if (!controller.signal.aborted) {
          void queryClient.invalidateQueries({ queryKey: modeKey });
          void queryClient.invalidateQueries({ queryKey: filesKey });
          attempt.current = null;
          setPending(undefined);
        }
      }
    })();
  }

  function selectMode(mode: ChatApprovalMode) {
    if (!state) return;
    const expectedModeRevision = state.modeRevision;
    run("mode", "Could not change the approval mode. Refresh the session and try again.", async (signal) => {
      const next = await updateChatApprovalMode(sessionId, { mode, expectedModeRevision }, signal);
      signal.throwIfAborted();
      if (next.workspaceId !== workspaceId || next.projectId !== projectId || next.mode !== mode) {
        throw new Error("Approval mode scope changed.");
      }
      await queryClient.cancelQueries({ queryKey: modeKey });
      signal.throwIfAborted();
      queryClient.setQueryData(modeKey, next);
      if (mode === "standard") setOpen(false);
      return mode === "auto" ? "Auto mode enabled." : "Standard mode enabled.";
    });
  }

  function restore(file: ManagedProjectFileRevision) {
    if (!state || !file.canRestore) return;
    const expectedModeRevision = state.modeRevision;
    run(
      file.revisionId,
      "Could not restore this version. The file or session may have changed. Check the refreshed list.",
      async (signal) => {
        const receipt = await restoreChatManagedFile(
          sessionId,
          {
            path: file.path,
            expectedRevision: file.revisionId,
            expectedModeRevision,
          },
          signal,
        );
        if (
          receipt.workspaceId !== workspaceId ||
          receipt.projectId !== projectId ||
          receipt.path !== file.path ||
          receipt.previousRevisionId !== file.revisionId ||
          receipt.deleted
        ) {
          throw new Error("Managed restore receipt scope changed.");
        }
        return `Restored the previous version of ${file.path}.`;
      },
    );
  }

  function download(file: ManagedProjectFileRevision) {
    run(file.revisionId, "Could not download this version. Check the refreshed list and try again.", async (signal) => {
      const bytes = await downloadChatManagedFile(sessionId, file, signal);
      signal.throwIfAborted();
      const url = URL.createObjectURL(bytes);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.path.split("/").at(-1) || "managed-file";
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return `Downloaded ${file.path} for separate publishing.`;
    });
  }

  function publish(input: ManagedProjectFilePublishRequest) {
    setOverwriteReview(undefined);
    run(
      "publish",
      "Could not verify the publish. Check the original project folder before trying again.",
      async (signal) => {
        const result = await publishChatManagedFile(sessionId, input, signal);
        signal.throwIfAborted();
        if (result.status === "overwrite_required") {
          setOverwriteReview({ ...input, overwriteRevision: result.overwriteRevision });
          return undefined;
        }
        return `Published ${result.path} to the original project folder.`;
      },
    );
  }

  const eligibleFiles =
    files.data?.items.filter(
      (file) => file.workspaceId === workspaceId && file.projectId === projectId && !file.deleted,
    ) ?? [];
  const mutatingDisabled =
    !canMutate || turnActive || pending !== undefined || modeQuery.isFetching || modeQuery.isError;
  const fileActionsDisabled = pending !== undefined || modeQuery.isFetching || files.isFetching || files.isError;
  const message = error ?? status;
  const announcement = message ? (
    <p role={error ? "alert" : "status"} className={`text-sm ${error ? "text-status-failed" : "text-fg-secondary"}`}>
      {message}
    </p>
  ) : null;
  return (
    <section aria-label="Chat approval mode" className="border-t border-line-subtle px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm text-fg-secondary">
          {modeQuery.isError
            ? "Approval mode unavailable"
            : auto
              ? "Auto · Managed project workspace"
              : "Standard approvals"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={mutatingDisabled && pending !== "mode"}
          loading={pending === "mode"}
          onClick={() => selectMode(auto ? "standard" : "auto")}
        >
          {auto ? "Use Standard mode" : "Use Auto mode"}
        </Button>
        {modeQuery.isError ? (
          <Button size="sm" onClick={() => void modeQuery.refetch()}>
            Retry
          </Button>
        ) : null}
        {auto ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Managed files
          </Button>
        ) : null}
      </div>
      {auto ? (
        <p className="text-sm text-fg-muted">
          Saves go to {projectName ? `the managed workspace for ${projectName}` : "the managed project workspace"}.
          Deletions always ask for approval.
        </p>
      ) : null}
      {!open || !auto ? announcement : null}
      <Dialog
        open={open && Boolean(auto)}
        onOpenChange={(next) => {
          if (!next) setOverwriteReview(undefined);
          setOpen(next);
        }}
        title="Managed project files"
        description="Publish a saved version to the original project folder, or download a copy."
      >
        <form
          className="mb-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const path = pathInput.trim();
            const next = path.replace(/\/+$/u, "") || path;
            if (next === prefix) void files.refetch();
            else setPrefix(next);
          }}
        >
          <Field
            label="File or folder path"
            help="Enter a path relative to the managed project, such as notes or notes/brief.txt."
          >
            {(field) => (
              <input
                {...field}
                value={pathInput}
                maxLength={512}
                onChange={(event) => setPathInput(event.currentTarget.value)}
                className="w-full rounded-md border border-line-control bg-raised px-2 py-1 text-fg"
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              Find files
            </Button>
            {prefix ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPathInput("");
                  setPrefix("");
                }}
              >
                Clear path
              </Button>
            ) : null}
          </div>
        </form>
        {announcement}
        {files.isFetching ? <p className="text-sm text-fg-secondary">Refreshing managed files…</p> : null}
        {files.isError ? (
          <div className="grid gap-2">
            <p className="text-sm text-status-failed">
              Managed files are unavailable. Check the path and allow project.files.* in tools.allow in
              config/tool-policy.json.
            </p>
            <Button size="sm" onClick={() => void files.refetch()}>
              Refresh managed files
            </Button>
          </div>
        ) : null}
        {!files.isError && files.isSuccess && eligibleFiles.length === 0 ? (
          <p className="text-sm text-fg-secondary">
            {prefix ? "No files match this path." : "No managed files saved yet."}
          </p>
        ) : null}
        {!files.isError && eligibleFiles.length === 200 ? (
          <p className="text-sm text-fg-secondary">
            Showing the first 200 matches. Enter a more specific path to find other files.
          </p>
        ) : null}
        {!files.isError && eligibleFiles.length ? (
          <ul className="max-h-64 divide-y divide-line-subtle overflow-y-auto">
            {eligibleFiles.map((file) => (
              <li key={file.path} className="grid gap-2 py-2">
                <span className="min-w-0 wrap-anywhere text-sm text-fg">{file.path}</span>
                <div className="flex flex-wrap gap-2">
                  {file.canRestore ? (
                    <Button
                      size="sm"
                      aria-label={`Restore previous version of ${file.path}`}
                      disabled={fileActionsDisabled || !canMutate || turnActive}
                      onClick={() => restore(file)}
                    >
                      Restore previous version
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    aria-label={`Download ${file.path}`}
                    disabled={fileActionsDisabled}
                    onClick={() => download(file)}
                  >
                    Download
                  </Button>
                  {files.data?.publishAvailable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Publish ${file.path}`}
                      disabled={fileActionsDisabled || !canMutate || turnActive || overwriteReview?.path === file.path}
                      onClick={() =>
                        state &&
                        publish({
                          path: file.path,
                          expectedRevision: file.revisionId,
                          expectedModeRevision: state.modeRevision,
                        })
                      }
                    >
                      Publish
                    </Button>
                  ) : null}
                </div>
                {overwriteReview?.path === file.path ? (
                  <ManagedFileOverwriteReview
                    path={file.path}
                    disabled={
                      fileActionsDisabled ||
                      !canMutate ||
                      turnActive ||
                      overwriteReview.expectedRevision !== file.revisionId ||
                      overwriteReview.expectedModeRevision !== state?.modeRevision
                    }
                    onCancel={() => setOverwriteReview(undefined)}
                    onConfirm={() => publish(overwriteReview)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Dialog>
    </section>
  );
}
