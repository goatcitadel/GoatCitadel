import { useState } from "react";
import { isOperatorWriteRootPathText, type OperatorWriteRootSummary } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { FilesystemToolAccessPanel, type ToolAccessReviewRequest } from "./FilesystemToolAccessPanel";
import { OutsideRootWriteModeControl } from "./OutsideRootWriteModeControl";
import {
  ConfiguredFolders,
  FilesToolsOffNote,
  WriteAccessOutcomeStatus,
  WriteAccessReviewDialog,
  type WriteAccessReview,
} from "./FilesystemWriteAccessParts";
import {
  DENY_WINS_COPY,
  TOOL_ACCESS_LABELS,
  operatorWriteRoots,
  outsideRootWriteMode,
  readdRootChange,
  removeRootChange,
  rootName,
  toolAccessConsequence,
  toolAccessRisk,
  type AddRootDraft,
} from "./filesystem-write-access";
import { useFilesystemWriteAccess, type WriteAccessOutcome } from "./use-filesystem-write-access";

const PATH_HINT = "Enter an absolute folder path, for example D:\\Scratch or /srv/scratch.";

export function FilesystemWriteRootsControl() {
  const control = useFilesystemWriteAccess();
  const { settings, ready, addDraft, toolDraft, change, busy, setNotice, locked, submit } = control;
  const [review, setReview] = useState<WriteAccessReview | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const revision = settings.data?.revision ?? 0;
  const roots = operatorWriteRoots(settings.data);
  const before = roots.map((root) => root.path);
  const hasTempPreset = roots.some((root) => root.preset === "os_temp");

  function reportUnsaved(outcome: WriteAccessOutcome, subject: string) {
    if (outcome.kind === "rejected")
      setNotice({ tone: "failed", message: `${subject} was not saved. ${outcome.message}` });
  }

  async function saveAdd(draft: AddRootDraft, baseRevision: number) {
    const path = draft.path.trim();
    const outcome = await submit(
      { kind: "root", change: { action: "add", path, allowDelete: draft.allowDelete }, before, draft },
      baseRevision,
    );
    if (outcome.kind === "rejected") setPathError(outcome.message);
    if (outcome.kind !== "saved") return;
    const added = operatorWriteRoots(outcome.settings).find((root) => !before.includes(root.path));
    setNotice({
      tone: "done",
      message: `Added ${added?.path ?? path}. Delete is ${draft.allowDelete ? "allowed" : "off"} in this folder.`,
    });
  }

  function addFolder() {
    const draft = addDraft.value;
    if (!isOperatorWriteRootPathText(draft.path)) {
      setPathError(PATH_HINT);
      return;
    }
    if (!draft.allowDelete) {
      void saveAdd(draft, revision);
      return;
    }
    setReview({
      title: "Add a folder Chat can delete in?",
      description: `Add ${draft.path.trim()} as an operator write root with delete allowed. Chat can create, change, move and delete files inside it, under your approval rule. ${DENY_WINS_COPY}`,
      confirmLabel: "Add folder with delete allowed",
      danger: true,
      revision,
      run: () => saveAdd(draft, revision),
    });
  }

  async function addTempFolder() {
    const outcome = await submit({ kind: "root", change: { action: "add", preset: "os_temp" }, before }, revision);
    reportUnsaved(outcome, "The OS temp folder");
    if (outcome.kind !== "saved") return;
    const added = operatorWriteRoots(outcome.settings).find((root) => root.preset === "os_temp");
    setNotice({
      tone: "done",
      message: `Added the OS temp folder: ${added?.path ?? "path not reported"}. Delete is off; turn on Allow delete only if Chat should clean it.`,
    });
  }

  async function removeRoot(root: OperatorWriteRootSummary) {
    const outcome = await submit({ kind: "root", change: removeRootChange(root), before }, revision);
    reportUnsaved(outcome, rootName(root));
    if (outcome.kind === "saved")
      setNotice({ tone: "done", message: `Removed ${rootName(root)}. Files in it are left as they are.` });
  }

  /** The Gateway has no in-place edit, so changing delete removes the folder and adds it back. */
  async function changeAllowDelete(root: OperatorWriteRootSummary, allowDelete: boolean, baseRevision: number) {
    const name = rootName(root);
    const state = allowDelete ? "on" : "off";
    const removed = await submit({ kind: "root", change: removeRootChange(root), before }, baseRevision);
    reportUnsaved(removed, name);
    if (removed.kind === "pending")
      setNotice({
        tone: "waiting",
        message: `Removing ${name} is waiting for review. After it settles, add the folder again with delete ${state}.`,
      });
    if (removed.kind !== "saved") return;
    const remaining = before.filter((path) => path !== root.path);
    const added = await submit(
      { kind: "root", change: readdRootChange(root, allowDelete), before: remaining },
      removed.revision,
    );
    if (added.kind === "saved") setNotice({ tone: "done", message: `Delete is now ${state} in ${name}.` });
    else if (added.kind === "pending")
      setNotice({
        tone: "waiting",
        message: `${name} was removed. Adding it back with delete ${state} is waiting for review.`,
      });
    else if (added.kind !== "failed")
      setNotice({
        tone: "failed",
        message: `${name} was removed but not added back. ${added.kind === "rejected" ? added.message : ""} Add it again below.`,
      });
  }

  function reviewAllowDelete(root: OperatorWriteRootSummary, allowDelete: boolean) {
    const name = rootName(root);
    setReview({
      title: allowDelete ? `Allow delete in ${name}?` : `Turn off delete in ${name}?`,
      description: allowDelete
        ? `Chat can delete files and move them out of ${root.path}, under your approval rule. GoatCitadel saves this by removing the folder and adding it back with delete allowed. ${DENY_WINS_COPY}`
        : `Delete and move-out stay blocked in ${root.path}. GoatCitadel saves this by removing the folder and adding it back with delete off.`,
      confirmLabel: allowDelete ? "Allow delete" : "Turn off delete",
      danger: allowDelete,
      revision,
      run: () => changeAllowDelete(root, allowDelete, revision),
    });
  }

  async function saveTool({ tool, next }: ToolAccessReviewRequest, baseRevision: number) {
    const outcome = await submit(
      {
        kind: "tool",
        change: { toolName: tool, posture: next },
        draft: toolDraft.value,
        saved: { ...control.currentTools, [tool]: next },
      },
      baseRevision,
    );
    reportUnsaved(outcome, `${tool} access`);
    if (outcome.kind === "saved") setNotice({ tone: "done", message: `${tool} is now ${TOOL_ACCESS_LABELS[next]}.` });
  }

  function applyTool(request: ToolAccessReviewRequest) {
    if (toolAccessRisk(request.tool, request.current, request.next) !== "danger") {
      void saveTool(request, revision);
      return;
    }
    setReview({
      title: `Make ${request.tool} ${TOOL_ACCESS_LABELS[request.next].toLowerCase()}?`,
      description: `${toolAccessConsequence(request.tool, request.next)} ${DENY_WINS_COPY}`,
      confirmLabel: `Set ${request.tool} to ${TOOL_ACCESS_LABELS[request.next]}`,
      danger: true,
      revision,
      run: () => saveTool(request, revision),
    });
  }

  const reviewCurrent = Boolean(review && review.revision === revision && !settings.isFetching);

  return (
    <section
      id="filesystem-write-roots"
      aria-labelledby="filesystem-write-roots-title"
      className="mt-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="filesystem-write-roots-title" className="text-base font-semibold text-fg">
            Filesystem write roots
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Folders outside the workspace where Chat's filesystem tools may write, such as a temp folder to clean.{" "}
            {DENY_WINS_COPY}
          </p>
        </div>
        <Button
          size="sm"
          disabled={settings.isFetching || busy}
          onClick={() => {
            void settings.refetch();
            if (change.change) void change.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {settings.isLoading ? <p className="mt-3 text-sm text-fg-muted">Loading filesystem access…</p> : null}
      {settings.isError ? (
        <p className="mt-3 text-sm text-status-failed">{describeApiError(settings.error).summary}</p>
      ) : null}
      {settings.data && !settings.isError && !ready ? (
        <p className="mt-3 text-sm text-status-failed">
          GoatCitadel did not report write roots or tool access. Update or restart GoatCitadel, then refresh before
          changing these settings.
        </p>
      ) : null}
      {ready && settings.data ? (
        <>
          <FilesToolsOffNote switchedOffToolGroups={settings.data.switchedOffToolGroups} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ConfiguredFolders title="Workspace write folders" paths={settings.data.writeJailRoots} />
            <ConfiguredFolders title="Read-only folders" paths={settings.data.readOnlyRoots} />
          </div>
          <p className="mt-2 text-xs text-fg-muted">These are edited in the config file, not here.</p>
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              tool-policy sandbox.writeJailRoots and sandbox.readOnlyRoots · settings version {revision}
            </p>
          </TechnicalDetails>
          <h4 id="operator-write-roots-title" className="mt-5 text-sm font-semibold text-fg">
            Operator write roots
          </h4>
          {roots.length === 0 ? (
            <p className="mt-1 text-sm text-fg-secondary">
              None yet. Chat's filesystem tools can write only inside the workspace write folders
              {outsideRootWriteMode(settings.data) === "approval_required"
                ? ", or elsewhere after you approve the write."
                : "."}
            </p>
          ) : (
            <ul aria-labelledby="operator-write-roots-title" className="mt-2 divide-y divide-line-subtle">
              {roots.map((root) => (
                <li key={root.path} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-fg">{rootName(root)}</p>
                    {rootName(root) !== root.path ? (
                      <p className="break-all font-mono text-xs text-fg-secondary">{root.path}</p>
                    ) : null}
                    <p className="text-xs text-fg-muted">
                      Delete {root.allowDelete ? "allowed" : "off"}
                      {root.addedAt ? (
                        <>
                          {" · "}
                          <TimeText value={root.addedAt} prefix="Added" />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex min-h-10 items-center gap-2 text-sm text-fg">
                      <input
                        type="checkbox"
                        className="size-4 accent-accent"
                        checked={root.allowDelete}
                        disabled={locked || Boolean(review)}
                        onChange={(event) => reviewAllowDelete(root, event.target.checked)}
                      />
                      Allow delete
                      <span className="sr-only"> in {rootName(root)}</span>
                    </label>
                    <Button size="sm" disabled={locked || Boolean(review)} onClick={() => void removeRoot(root)}>
                      Remove<span className="sr-only"> {rootName(root)}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-4 max-w-xl space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              addFolder();
            }}
          >
            <Field
              label="Add folder"
              help="GoatCitadel checks the folder and refuses GoatCitadel's own runtime files and system folders."
              error={pathError ?? undefined}
            >
              {(props) => (
                <input
                  {...props}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="D:\Scratch"
                  className="block min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 font-mono text-md text-fg sm:text-sm"
                  value={addDraft.value.path}
                  disabled={locked}
                  onChange={(event) => {
                    setPathError(null);
                    setNotice(null);
                    addDraft.setValue((draft) => ({ ...draft, path: event.target.value }));
                  }}
                />
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={addDraft.value.allowDelete}
                disabled={locked}
                onChange={(event) => addDraft.setValue((draft) => ({ ...draft, allowDelete: event.target.checked }))}
              />
              Allow delete in this folder
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                loadingLabel="Saving…"
                disabled={locked || !addDraft.value.path.trim() || Boolean(review)}
              >
                Add folder
              </Button>
              {hasTempPreset ? null : (
                <Button disabled={locked || Boolean(review)} onClick={() => void addTempFolder()}>
                  Add OS temp folder
                </Button>
              )}
            </div>
            {hasTempPreset ? null : (
              <p className="text-xs text-fg-muted">
                GoatCitadel finds this computer's temp folder and adds it with delete off. Its path shows after saving.
              </p>
            )}
          </form>
          <FilesystemToolAccessPanel control={control} onApply={applyTool} />
          <OutsideRootWriteModeControl control={control} reviewOpen={Boolean(review)} onReview={setReview} />
        </>
      ) : null}
      <WriteAccessOutcomeStatus control={control} />
      <WriteAccessReviewDialog review={review} current={reviewCurrent} busy={busy} onClose={() => setReview(null)} />
    </section>
  );
}
