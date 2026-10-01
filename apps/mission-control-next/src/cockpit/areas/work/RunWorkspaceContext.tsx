import { useEffect, useRef, useState } from "react";
import type { ChatSessionWorkbenchFileResponse, ChatSessionWorkbenchRecord, ChatSessionWorkbenchTreeResponse } from "@goatcitadel/contracts";
import type { ObserveRunTraceResponse } from "@goatcitadel/mission-control-shared/api/durable";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { canInspectWorkspaceFiles, readRunWorkspaceContext, readRunWorkspaceFile, readRunWorkspaceTree, runWorkspaceSession } from "./run-workspace-context";

const MAX_CHANGED_FILES = 40;
const MAX_TREE_ITEMS = 60;
type Inspection = { state: "idle" | "loading" | "error"; error?: string }
  | { state: "ready"; workbench: ChatSessionWorkbenchRecord; tree?: ChatSessionWorkbenchTreeResponse };
type Preview = { path: string; state: "loading" | "error"; error?: string }
  | { path: string; state: "ready"; file: ChatSessionWorkbenchFileResponse };

export function RunWorkspaceContext({ trace, workspaceId }: { trace: ObserveRunTraceResponse; workspaceId: string }) {
  const sessionId = runWorkspaceSession(trace, workspaceId);
  return <section aria-label="Current conversation worktree" className="rounded-lg border border-line bg-raised p-4">
    <h2 className="font-display text-lg font-semibold text-fg">Current conversation worktree</h2>
    <p className="mt-2 text-sm text-fg-secondary">Inspect the conversation's current worktree and files. This snapshot may include changes made after this run; it does not identify which changes the run made.</p>
    {sessionId ? <WorkspaceInspector key={JSON.stringify([workspaceId, trace.runId, sessionId])} sessionId={sessionId} workspaceId={workspaceId} />
      : <p className="mt-3 text-sm text-fg-muted">Worktree context unavailable: this run has no consistent Gateway-resolved conversation in this workspace.</p>}
  </section>;
}

function WorkspaceInspector({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
  const [inspection, setInspection] = useState<Inspection>({ state: "idle" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current += 1; }, []);
  const scopeFor = (id: number) => ({ workspaceId, sessionId, isCurrent: () => requestId.current === id });
  const closePreview = () => { requestId.current += 1; setPreview(null); };

  const inspect = async (files = false) => {
    const id = ++requestId.current;
    const previous = inspection.state === "ready" ? inspection.workbench : undefined;
    setPreview(null);
    setInspection({ state: "loading" });
    try {
      const scope = scopeFor(id);
      if (files && previous) {
        const tree = await readRunWorkspaceTree(scope, previous);
        if (scope.isCurrent()) setInspection({ state: "ready", workbench: tree.state, tree });
      } else {
        const workbench = await readRunWorkspaceContext(scope);
        if (scope.isCurrent()) setInspection({ state: "ready", workbench });
      }
    } catch (cause) {
      if (requestId.current === id) setInspection({ state: "error", error: describeApiError(cause).summary });
    }
  };

  const openFile = async (path: string) => {
    if (inspection.state !== "ready" || !inspection.tree) return;
    const id = ++requestId.current;
    setPreview({ path, state: "loading" });
    try {
      const file = await readRunWorkspaceFile(scopeFor(id), inspection.workbench, path);
      if (requestId.current === id) setPreview({ path, state: "ready", file });
    } catch (cause) {
      if (requestId.current === id) {
        const error = describeApiError(cause).summary;
        setPreview({ path, state: "error", error });
        setInspection({ state: "error", error: "File inspection could not confirm the current context. Refresh before continuing." });
      }
    }
  };

  const workbench = inspection.state === "ready" ? inspection.workbench : undefined;
  const tree = inspection.state === "ready" ? inspection.tree : undefined;
  return <div className="mt-3 grid min-w-0 gap-3">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={inspection.state === "loading"} onClick={() => void inspect()}>
        {inspection.state === "idle" ? "Inspect current worktree" : "Refresh worktree context"}
      </Button>
      {workbench && canInspectWorkspaceFiles(workbench) && !tree ? <Button size="sm" onClick={() => void inspect(true)}>Inspect files</Button> : null}
    </div>
    {inspection.state === "loading" ? <p role="status" className="text-sm text-fg-muted">Checking current conversation and worktree…</p> : null}
    {inspection.state === "error" ? <p role="alert" className="text-sm text-status-failed">{inspection.error}</p> : null}
    {workbench ? <>
      <dl className="grid min-w-0 gap-3 rounded-md border border-line-subtle p-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-fg-muted">Worktree status</dt><dd className="text-fg">{humanizeToken(workbench.worktreeStatus)}</dd></div>
        <div><dt className="text-xs text-fg-muted">Base reference</dt><dd className="break-all text-fg">{workbench.baseRef || "Not recorded"}</dd></div>
        <div className="min-w-0 sm:col-span-2"><dt className="text-xs text-fg-muted">Worktree path</dt><dd className="break-all text-fg">{workbench.worktreePath || "Not recorded"}</dd></div>
        <div><dt className="text-xs text-fg-muted">Current project</dt><dd className="break-all text-fg">{workbench.projectId || "No project recorded"}</dd></div>
      </dl>
      {!canInspectWorkspaceFiles(workbench) ? <p className="text-sm text-fg-muted">File inspection needs a ready worktree with a recorded project and path.</p> : null}
      <p className="text-xs text-fg-muted">Snapshot from your last inspection. Refresh to check for later changes.</p>
    </> : null}
    {tree ? <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <section className="min-w-0" aria-label="Current changed files">
        <h3 className="text-sm font-semibold text-fg">Current changed paths</h3>
        <p className="mt-1 text-xs text-fg-muted">Up to {MAX_CHANGED_FILES} returned paths. A path may be deleted or unavailable to preview.</p>
        {tree.changedFiles.length ? <ul className="mt-2 grid gap-1">{tree.changedFiles.slice(0, MAX_CHANGED_FILES).map((path) => <li key={path} className="min-w-0">
          <FileButton path={path} onClick={() => void openFile(path)} />
        </li>)}</ul> : <p className="mt-2 text-sm text-fg-muted">No changed paths were returned in this snapshot.</p>}
      </section>
      <section className="min-w-0" aria-label="Current file tree">
        <h3 className="text-sm font-semibold text-fg">File tree</h3>
        <p className="mt-1 text-xs text-fg-muted">Up to {MAX_TREE_ITEMS} returned entries. The Gateway tree is bounded and may omit other files.</p>
        {tree.items.length ? <ul className="mt-2 grid gap-1">{tree.items.slice(0, MAX_TREE_ITEMS).map((item) => <li key={item.path} className="min-w-0">
          {item.kind === "file" ? <FileButton path={item.path} onClick={() => void openFile(item.path)} />
            : <span className="block break-all px-2 py-1 text-xs text-fg-muted">{item.path}/</span>}
        </li>)}</ul> : <p className="mt-2 text-sm text-fg-muted">No entries were returned.</p>}
      </section>
    </div> : null}
    <Sheet open={preview !== null} onOpenChange={(open) => { if (!open) closePreview(); }} title="Current file preview" sideOnDesktop>
      {preview ? <div className="grid min-w-0 gap-3">
        <p className="break-all text-sm font-medium text-fg">{preview.path}</p>
        <p className="text-xs text-fg-muted">Read-only file content from the current worktree. This is not a historical run snapshot.</p>
        {preview.state === "loading" ? <p role="status" className="text-sm text-fg-muted">Checking current scope and reading file…</p>
          : preview.state === "error" ? <p role="alert" className="text-sm text-status-failed">{preview.error}</p>
            : preview.state === "ready" ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-sunken p-3 font-mono text-sm text-fg"><code>{preview.file.content}</code></pre> : null}
      </div> : null}
    </Sheet>
  </div>;
}

function FileButton({ path, onClick }: { path: string; onClick: () => void }) {
  return <button type="button" aria-label={`Preview ${path}`} onClick={onClick}
    className="w-full rounded-md px-2 py-1 text-left text-sm text-accent hover:bg-sunken"><span className="break-all">{path}</span></button>;
}
