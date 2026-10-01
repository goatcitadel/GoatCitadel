import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { DetailInspector } from "../../../../components/DetailInspector";
import { Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { HookMode, HookTrigger } from "@goatcitadel/contracts";
import { useHooksSettings } from "./use-hooks-settings";
import { HOOK_MODES as MODES, HOOK_TRIGGER_VALUES as HOOK_TRIGGERS } from "./hooks-owner-binding";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import {
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  SettingsSectionShell,
  SettingsStack,
  type SettingsSectionProps,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";

export function HooksSection({ activeWorkspaceId }: SettingsSectionProps) {
  const owner = useHooksSettings(activeWorkspaceId);
  const {
    loading,
    error,
    data,
    reload,
    notice,
    hooks,
    selectedHook,
    selectedRuns,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    selectedRunCanRedrive,
    view,
    openView,
    form,
    setForm,
    editor,
    leave,
  } = owner;
  const creating = owner.mutation.locked;
  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      <SettingsStack>
        {notice ? <SettingsNotice notice={notice} /> : null}
        {owner.uncertainty ? <p role="alert">{owner.uncertainty}</p> : null}
        <SettingsLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
        <SettingsButtonRow>
          <NativeButton onClick={() => openView("new")}>Register hook{editor.isDirty ? " · Unsaved" : ""}</NativeButton>
          <NativeButton variant="outline" onClick={() => openView("history")}>
            Delivery history
          </NativeButton>
          <NativeButton variant="outline" onClick={() => void reload()}>
            Refresh
          </NativeButton>
        </SettingsButtonRow>
        {view === "new" ? (
          <DetailInspector open title="Register hook" onClose={() => openView(null)}>
            <NativeCard
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
                <NativeButton variant="default" disabled={creating} onClick={owner.reviewCreate}>
                  <Plus size={16} />
                  Review hook registration
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void reload()}>
                  <RefreshCw size={16} />
                  Refresh
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
          </DetailInspector>
        ) : null}
        {hooks.length ? (
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Registered hooks"
            subtitle="Select a hook to inspect delivery evidence or review an explicit real test delivery."
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
                owner.selectHook(hookId);
              }}
              emptyLabel="No hooks configured."
            />
          </NativeCard>
        ) : (
          <SettingsEmptyState label="No hooks yet. Create a signed HTTPS hook to receive a governed lifecycle event." />
        )}
        {selectedHook ? (
          <DetailInspector open={view === "hook"} title={selectedHook.label} onClose={() => openView(null)}>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title={selectedHook.label}
              subtitle={`${selectedHook.trigger} · ${selectedHook.phase} phase · ${selectedHook.failPolicy} failure policy`}
            >
              <p className="mc-next-settings-field-note">
                Workspace: {activeWorkspaceId} · {selectedHook.enabled ? "Enabled" : "Disabled"}
              </p>
              <details>
                <summary>Configuration and governance</summary>
                <pre>
                  {JSON.stringify(
                    {
                      hookId: selectedHook.hookId,
                      workspaceId: selectedHook.workspaceId,
                      enabled: selectedHook.enabled,
                      trigger: selectedHook.trigger,
                      phase: selectedHook.phase,
                      mode: selectedHook.mode,
                      priority: selectedHook.priority,
                      timeoutMs: selectedHook.timeoutMs,
                      failPolicy: selectedHook.failPolicy,
                      dataScope: selectedHook.dataScope,
                      actionType: selectedHook.action.type,
                      createdAt: selectedHook.createdAt,
                      updatedAt: selectedHook.updatedAt,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
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
                  {
                    label: "Latest retained outcome",
                    value: data?.issues.some((issue) => issue.label === "Hook deliveries")
                      ? "Unavailable"
                      : (selectedRuns[0]?.status ?? "No delivery"),
                  },
                  {
                    label: "Last delivery",
                    value: selectedRuns[0] ? `Attempt ${selectedRuns[0].attemptCount}` : "None",
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton
                  variant="secondary"
                  disabled={owner.mutation.locked || !selectedHook.enabled}
                  onClick={() => owner.reviewHook("test", selectedHook)}
                >
                  <Play size={16} />
                  Review real test delivery
                </NativeButton>
                <NativeButton
                  variant="destructive"
                  disabled={owner.mutation.locked}
                  onClick={() => owner.reviewHook("delete", selectedHook)}
                >
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
                      disabled={owner.mutation.locked || !selectedRunCanRedrive}
                      onClick={() => selectedRun && owner.reviewRedrive(selectedRun)}
                    >
                      <Play size={16} />
                      Review redrive selected delivery
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
            </NativeCard>
          </DetailInspector>
        ) : null}
        <DetailInspector open={view === "history"} title="Hook delivery history" onClose={() => openView(null)}>
          {data?.issues.some((issue) => issue.label === "Hook deliveries") ? (
            <p role="status">Delivery history is unavailable. Retry the read; no delivery outcome can be inferred.</p>
          ) : null}
          <NativeSelectableList
            items={(data?.runs ?? []).map((run) => ({
              id: run.runId,
              title: `${run.status} · ${run.trigger}`,
              meta: run.createdAt,
              body: `Hook ${run.hookId} · attempt ${run.attemptCount}`,
            }))}
            selectedId={selectedRunId}
            onSelect={setSelectedRunId}
            emptyLabel="No retained deliveries returned."
            maxHeight=""
          />
          {selectedRun ? (
            <details open key={selectedRun.runId}>
              <summary>Delivery details</summary>
              <pre>
                {JSON.stringify(
                  {
                    runId: selectedRun.runId,
                    hookId: selectedRun.hookId,
                    workspaceId: selectedRun.workspaceId,
                    trigger: selectedRun.trigger,
                    entityType: selectedRun.entityType,
                    entityId: selectedRun.entityId,
                    mode: selectedRun.mode,
                    status: selectedRun.status,
                    attemptCount: selectedRun.attemptCount,
                    createdAt: selectedRun.createdAt,
                    updatedAt: selectedRun.updatedAt,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          ) : null}
        </DetailInspector>
        {leave.dialog}
        <ConfirmModal
          open={Boolean(owner.review)}
          danger
          pending={owner.mutation.pending}
          title={owner.review?.title ?? "Review hook action"}
          message={owner.review?.description ?? ""}
          confirmLabel="Apply reviewed hook action"
          onCancel={owner.cancelReview}
          onConfirm={() => void owner.confirmReview()}
        />
      </SettingsStack>
    </SettingsSectionShell>
  );
}
