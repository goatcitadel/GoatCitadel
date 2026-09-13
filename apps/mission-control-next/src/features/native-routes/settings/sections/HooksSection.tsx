import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { useCallback, useRef, useState } from "react";
import { Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { HookMode, HookTrigger } from "@goatcitadel/contracts";
import {
  createWorkspaceHook,
  deleteWorkspaceHook,
  fetchWorkspaceHookRuns,
  fetchWorkspaceHooks,
  redriveWorkspaceHookRun,
  testWorkspaceHook,
} from "./hooks-api";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
  nativeLoad,
  nativeLoadIssues,
  type SettingsSectionProps,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";

const MODES: HookMode[] = ["observe", "mutate", "intercept"];
// Keep the form available in a linked worktree before its contracts build has
// refreshed the installed package artifact. The Gateway remains the authority
// and rejects anything not present in its typed registry.
const HOOK_TRIGGERS: readonly HookTrigger[] = [
  "llm.model.select.before",
  "llm.request.before",
  "gateway.dispatch.before",
  "transform_llm_output",
  "llm.response.after",
  "before_prompt_build",
  "llm_input",
  "llm_output",
  "tool.call.before",
  "tool.call.after",
  "tool.call.error",
  "after_tool_call",
  "approval.request.before",
  "approval.create.before",
  "approval.resolve.after",
  "approval.response.after",
  "orchestration.run.before",
  "orchestration.phase.before",
  "orchestration.phase.after",
  "orchestration.retry.scheduled",
  "orchestration.run.woken",
  "before_message_write",
  "agent_end",
  "session.start",
  "session.end",
  "prompt.submit.before",
  "context.compaction.before",
  "context.compaction.after",
  "subagent.start",
  "subagent.end",
  "agent.finalize.before",
];

export function HooksSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [hooks, runs] = await Promise.all([
      nativeLoad("Hooks", fetchWorkspaceHooks(activeWorkspaceId), { items: [] }),
      nativeLoad("Hook deliveries", fetchWorkspaceHookRuns(activeWorkspaceId), { items: [] }),
    ]);
    return { hooks: hooks.data.items, runs: runs.data.items, issues: nativeLoadIssues([hooks, runs]) };
  }, [activeWorkspaceId]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedHookId, setSelectedHookId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<"new" | "hook" | "history" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const creatingRef = useRef(false);
  const leave = useDraftLeave();
  const emptyForm = { label: "", trigger: "tool.call.after" as HookTrigger, mode: "observe" as HookMode, url: "", secret: "" };
  const editor = useSessionDraft(`hook:${activeWorkspaceId}:new`, emptyForm, undefined, { label: "New hook", active: view === "new", onSave: () => create() });
  const form = editor.value;
  const setForm = editor.setValue;
  const openView = (next: typeof view) => leave.request(() => setView(next), [editor.key]);
  const hooks = data?.hooks ?? [];
  const selectedHook = hooks.find((hook) => hook.hookId === selectedHookId) ;
  const selectedRuns = (data?.runs ?? []).filter((run) => view === "history" || run.hookId === selectedHook?.hookId);
  const selectedRun = selectedRuns.find((run) => run.runId === selectedRunId);
  const selectedRunCanRedrive = Boolean(
    selectedRun &&
    selectedHook?.phase === "after" &&
    selectedRun.mode === "observe" &&
    selectedRun.status === "completed",
  );

  const create = async (): Promise<boolean> => {
    if (creatingRef.current) return false;
    if (!form.label.trim() || !form.url.trim() || !form.secret.trim()) {
      setNotice({ tone: "warning", message: "Label, HTTPS URL, and signing secret are required." });
      return false;
    }
    setCreating(true); creatingRef.current = true;
    const submitted = form;
    try {
      const created = await createWorkspaceHook(activeWorkspaceId, {
        label: form.label.trim(),
        trigger: form.trigger,
        mode: form.mode,
        dataScope: "metadata",
        action: { type: "webhook", webhook: { url: form.url.trim(), secret: form.secret } },
      });
      setSelectedHookId(created.hookId);
      const clean = editor.acceptSaved(emptyForm, undefined, submitted);
      if (clean) setView("hook");
      setNotice({ tone: "success", message: "Hook created with a keychain-backed signing secret." });
      await reload();
      return clean;
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
      return false;
    } finally {
      setCreating(false); creatingRef.current = false;
    }
  };
  const test = async (hookId: string) => {
    try {
      await testWorkspaceHook(activeWorkspaceId, hookId);
      setNotice({ tone: "success", message: "Synthetic metadata-only test delivery recorded." });
      await reload();
    } catch (testError) {
      setNotice({ tone: "error", message: getErrorMessage(testError) });
    }
  };
  const redrive = async (runId: string) => {
    try {
      await redriveWorkspaceHookRun(activeWorkspaceId, runId);
      setNotice({ tone: "success", message: "Post-event observer delivery queued for redrive." });
      await reload();
    } catch (redriveError) {
      setNotice({ tone: "error", message: getErrorMessage(redriveError) });
    }
  };
  const remove = async (hookId: string) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteWorkspaceHook(activeWorkspaceId, hookId);
      setSelectedHookId(""); setPendingDelete(null); setView(null);
      setNotice({ tone: "success", message: "Hook deleted." });
      await reload();
    } catch (deleteError) {
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
    } finally { setDeleting(false); }
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
        <SettingsButtonRow><NativeButton onClick={() => openView("new")}>Register hook{editor.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="outline" onClick={() => openView("history")}>Delivery history</NativeButton><NativeButton variant="outline" onClick={() => void reload()}>Refresh</NativeButton></SettingsButtonRow>
        {view === "new" ? <DetailInspector open title="Register hook" onClose={() => openView(null)}><NativeCard
          density="compact"
          className="mc-next-settings-panel"
          title="Governed hooks"
          subtitle="Metadata-only delivery; policy, allowlists, approvals, and redaction remain authoritative."
          stats={[
            { label: "Hooks", value: String(hooks.length) },
            { label: "Recent deliveries", value: String(data?.runs.length ?? 0) },
            { label: "Payload", value: "Metadata" },
          ]}
        >
          <SettingsFieldGrid>
            <SettingsField label="Label">
              <input
                className="mc-next-settings-input"
                value={form.label}
                onChange={(event) => setForm((v) => ({ ...v, label: event.target.value }))}
              />
            </SettingsField>
            <SettingsField label="Lifecycle event">
              <select
                className="mc-next-settings-input"
                value={form.trigger}
                onChange={(event) => setForm((v) => ({ ...v, trigger: event.target.value as HookTrigger }))}
              >
                {HOOK_TRIGGERS.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {trigger}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField label="Mode">
              <select
                className="mc-next-settings-input"
                value={form.mode}
                onChange={(event) => setForm((v) => ({ ...v, mode: event.target.value as HookMode }))}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField label="Payload scope">
              <input className="mc-next-settings-input" value="Metadata only" disabled />
            </SettingsField>
            <SettingsField label="HTTPS endpoint" span={2}>
              <input
                className="mc-next-settings-input"
                value={form.url}
                onChange={(event) => setForm((v) => ({ ...v, url: event.target.value }))}
                placeholder="https://hooks.example.com/goatcitadel"
              />
            </SettingsField>
            <SettingsField label="Signing secret" span={2}>
              <input
                className="mc-next-settings-input"
                type="password"
                value={form.secret}
                onChange={(event) => setForm((v) => ({ ...v, secret: event.target.value }))}
                placeholder="Stored in your OS keychain; never displayed again"
              />
            </SettingsField>
          </SettingsFieldGrid>
          <SettingsButtonRow>
            <NativeButton variant="default" disabled={creating} onClick={() => void create()}>
              <Plus size={16} />
              Create hook
            </NativeButton>
            <NativeButton variant="secondary" onClick={() => void reload()}>
              <RefreshCw size={16} />
              Refresh
            </NativeButton>
          </SettingsButtonRow>
        </NativeCard></DetailInspector> : null}
        {hooks.length ? (
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Registered hooks"
            subtitle="Select a hook to inspect delivery evidence or safely test it."
          >
            <NativeSelectableList
              items={hooks.map((hook) => ({
                id: hook.hookId,
                title: hook.label,
                meta: `${hook.trigger} · ${hook.mode}`,
                body: `${hook.enabled ? "Enabled" : "Disabled"} · ${hook.dataScope ?? "metadata"} scope · ${hook.action.type === "webhook" ? "Signed webhook" : "Managed package"}`,
              }))}
              selectedId={selectedHook?.hookId ?? ""}
              onSelect={(hookId) => {
                leave.request(() => { setSelectedHookId(hookId); setSelectedRunId(""); setView("hook"); }, [editor.key]);
              }}
              emptyLabel="No hooks configured."
            />
          </NativeCard>
        ) : (
          <SettingsEmptyState label="No hooks yet. Create a signed HTTPS hook to receive a governed lifecycle event." />
        )}
        {selectedHook ? (
          <DetailInspector open={view === "hook"} title={selectedHook.label} onClose={() => openView(null)}><NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedHook.label}
            subtitle={`${selectedHook.trigger} · ${selectedHook.phase} phase · ${selectedHook.failPolicy} failure policy`}
          >
            <p className="mc-next-settings-field-note">Workspace: {activeWorkspaceId} · {selectedHook.enabled ? "Enabled" : "Disabled"}</p>
            <details><summary>Configuration and governance</summary><pre>{JSON.stringify({ hookId: selectedHook.hookId, workspaceId: selectedHook.workspaceId, enabled: selectedHook.enabled, trigger: selectedHook.trigger, phase: selectedHook.phase, mode: selectedHook.mode, priority: selectedHook.priority, timeoutMs: selectedHook.timeoutMs, failPolicy: selectedHook.failPolicy, dataScope: selectedHook.dataScope, actionType: selectedHook.action.type, createdAt: selectedHook.createdAt, updatedAt: selectedHook.updatedAt }, null, 2)}</pre></details>
            <NativeMetricGrid
              items={[
                { label: "Priority", value: String(selectedHook.priority) },
                { label: "Timeout", value: `${selectedHook.timeoutMs} ms` },
                {
                  label: "Signing",
                  value:
                    selectedHook.action.type === "webhook" && selectedHook.action.webhook.secretRef
                      ? "Keychain"
                      : "Legacy / needs rotation",
                },
                { label: "Data scope", value: selectedHook.dataScope ?? "metadata" },
                { label: "Latest retained outcome", value: data?.issues.some((issue) => issue.label === "Hook deliveries") ? "Unavailable" : selectedRuns[0]?.status ?? "No delivery" },
                { label: "Last delivery", value: selectedRuns[0] ? `Attempt ${selectedRuns[0].attemptCount}` : "None" },
              ]}
            />
            <SettingsButtonRow>
              <NativeButton variant="secondary" onClick={() => void test(selectedHook.hookId)}>
                <Play size={16} />
                Run safe test
              </NativeButton>
              <NativeButton variant="destructive" onClick={() => setPendingDelete(selectedHook.hookId)}>
                <Trash2 size={16} />
                Delete
              </NativeButton>
            </SettingsButtonRow>
            {selectedRuns.length ? (
              <>
                <NativeSelectableList
                  items={selectedRuns.map((run) => ({
                    id: run.runId,
                    title: `${run.status} · attempt ${run.attemptCount}`,
                    meta: run.createdAt,
                    body: run.errorText
                      ? "Delivery failure detail is redacted; inspect Gateway audit evidence."
                      : `${run.trigger} · ${run.entityType}`,
                  }))}
                  selectedId={selectedRunId}
                  onSelect={setSelectedRunId}
                  emptyLabel="No delivery evidence."
                />
                <SettingsButtonRow>
                  <NativeButton
                    variant="secondary"
                    disabled={!selectedRunCanRedrive}
                    onClick={() => selectedRun && void redrive(selectedRun.runId)}
                  >
                    <Play size={16} />
                    Redrive selected delivery
                  </NativeButton>
                </SettingsButtonRow>
              </>
            ) : (
              <p className="mc-next-settings-field-note">No delivery evidence for this hook yet.</p>
            )}
            <p className="mc-next-settings-field-note">
              Only a selected completed post-event observer delivery can be redriven. Inline control hooks are never
              replayed.
            </p>
          </NativeCard></DetailInspector>
        ) : null}
        <DetailInspector open={view === "history"} title="Hook delivery history" onClose={() => openView(null)}>
          {data?.issues.some((issue) => issue.label === "Hook deliveries") ? <p role="status">Delivery history is unavailable. Retry the read; no delivery outcome can be inferred.</p> : null}
          <NativeSelectableList items={(data?.runs ?? []).map((run) => ({ id: run.runId, title: `${run.status} · ${run.trigger}`, meta: run.createdAt, body: `Hook ${run.hookId} · attempt ${run.attemptCount}` }))} selectedId={selectedRunId} onSelect={setSelectedRunId} emptyLabel="No retained deliveries returned." maxHeight="" />
          {selectedRun ? <details open key={selectedRun.runId}><summary>Delivery details</summary><pre>{JSON.stringify({ runId: selectedRun.runId, hookId: selectedRun.hookId, workspaceId: selectedRun.workspaceId, trigger: selectedRun.trigger, entityType: selectedRun.entityType, entityId: selectedRun.entityId, mode: selectedRun.mode, status: selectedRun.status, attemptCount: selectedRun.attemptCount, createdAt: selectedRun.createdAt, updatedAt: selectedRun.updatedAt }, null, 2)}</pre></details> : null}
        </DetailInspector>
        {leave.dialog}
        <ConfirmModal open={pendingDelete !== null} danger pending={deleting} title="Delete hook?" message={`Delete ${hooks.find((hook) => hook.hookId === pendingDelete)?.label ?? "this hook"} from workspace ${activeWorkspaceId}? Existing delivery evidence remains available.`} confirmLabel="Delete hook" onCancel={() => setPendingDelete(null)} onConfirm={() => pendingDelete && void remove(pendingDelete)} />
      </SettingsStack>
    </SettingsSectionShell>
  );
}
