// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { CheckCircle2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import type { PersonalityPresetCategory } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  SettingsButtonRow,
  SettingsActionList,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsStack,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
} from "../SettingsShared";
import { hasSessionDraft } from "../../library/session-drafts";
import { PERSONALITY_DEFAULT_SCOPE } from "../use-personality-default";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList, StatusChip } from "../../primitives";
import {
  formatPersonalityCategoryLabel,
  formatPersonalityStatus,
} from "../helpers/personality-helpers";

const PERSONALITY_CATEGORY_OPTIONS: PersonalityPresetCategory[] = [
  "core",
  "critical",
  "execution",
  "social",
  "thinking",
  "flavor",
  "chaos",
];

import { usePersonalityEditor } from "../use-personality-editor";

export function PersonalitiesSection(_props: SettingsSectionProps) {
  const { loading, error, data, reload, notice, locked, mutation, selectedPersonalityId, editorMode, editorOpen, saving,
    catalogConflict, setCatalogConflict, pendingRemove, setPendingRemove, removePending, defaultSelection,
    selectedPersonality, defaultPersonalityId, customCount, modifiedBuiltinCount, editorLocked, editingBuiltin,
    canSave, editor, draft, isDirty, hasCatalogConflict, revisionUnavailable, closeEditor, personalityTransitionGuard,
    beginCustomPersonality, refreshPersonalities, savePersonality, removeOrResetPersonality, updateDraft, leave } = usePersonalityEditor();

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {mutation.uncertain ? <p role="alert">{mutation.uncertain}</p> : null}
      {defaultSelection.notice ? <p role={defaultSelection.uncertain ? "alert" : "status"}>{defaultSelection.notice}</p> : null}
      {/* F-M11: personalities is an experimental surface. Beyond the page-frame
          badge, state it inline since this section's labeling was the weakest. */}
      <p className="mc-next-settings-experimental-note" role="note">
        <strong>Experimental.</strong> Work personalities are an experimental surface and may change before 1.0.
      </p>
      {data ? (
        <SettingsStack>
          <div hidden={editorOpen}><NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Personality catalog"
            subtitle="Built-in presets, custom overlays, and the global Work default."
            stats={[
              { label: "Presets", value: String(data.items?.length ?? 0) },
              { label: "Custom", value: String(customCount) },
              { label: "Modified", value: String(modifiedBuiltinCount) },
            ]}
          >
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={beginCustomPersonality} disabled={locked}>
                <Plus size={16} />
                Add custom personality{hasSessionDraft("personality:system:new") ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton variant="secondary" onClick={refreshPersonalities}>
                <RefreshCw size={16} />
                Refresh
              </NativeButton>
            </SettingsButtonRow>
            <NativeSelectableList
              items={(data.items ?? []).map((item) => ({
                id: item.id,
                title: item.label,
                meta: `${formatPersonalityStatus(item, defaultPersonalityId)}${hasSessionDraft(`personality:system:${item.id}`) ? " · Unsaved" : ""}`,
                body: `${formatPersonalityCategoryLabel(item.category)} · ${item.tone || "No tone"} · ${
                  item.description || "No description"
                }`,
              }))}
              selectedId={editorMode === "new" ? "" : selectedPersonalityId}
              onSelect={(id) => {
                if (editorOpen && editorMode === "selected" && id === selectedPersonalityId) {
                  return;
                }
                personalityTransitionGuard.requestTransition({ kind: "select", id });
              }}
              emptyLabel="No personalities returned from the gateway."
              maxHeight=""
            />
          </NativeCard></div>
          {editorOpen ? <FocusedDetail title={editorMode === "new" ? "New custom personality" : selectedPersonality?.label ?? "Personality"} onClose={closeEditor}><NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={
              editorMode === "new" ? "New custom personality" : (selectedPersonality?.label ?? "Personality editor")
            }
            subtitle={
              editorMode === "new"
                ? "Create a persisted custom Work overlay."
                : "Edit tone fields, reset built-ins, or set the global Work default."
            }
            headerAccessory={
              isDirty ? (
                <StatusChip tone="warning" size="sm">
                  Unsaved
                </StatusChip>
              ) : null
            }
          >
            {editorMode === "new" || selectedPersonality ? (
              <>
                {editor.hasRemoteChanges || hasCatalogConflict ? <div role="status">
                  <p>The personality catalog changed. Your draft is preserved.</p>
                  <details><summary>Current saved instructions</summary>
                    <p>Current Work default: {data.items.find((item) => item.id === defaultPersonalityId)?.label ?? defaultPersonalityId}.</p>
                    {selectedPersonality && editorMode === "selected" ? <SettingsActionList ariaLabel="Current saved personality" items={[
                      { label: "ID", description: selectedPersonality.id },
                      { label: "Label", description: selectedPersonality.label },
                      { label: "Category", description: formatPersonalityCategoryLabel(selectedPersonality.category) },
                      { label: "Description", description: selectedPersonality.description || "No description" },
                      { label: "Tone", description: selectedPersonality.tone || "No tone" },
                      { label: "Style", description: selectedPersonality.style || "No style" },
                      { label: "System overlay", description: selectedPersonality.systemOverlay || "No overlay" },
                      { label: "Safety notes", description: selectedPersonality.safetyNotes.join(" ") || "No extra safety notes" },
                    ]} /> : <SettingsActionList ariaLabel="Current personality catalog" items={data.items.map((item) => ({
                      label: `${item.label} (${item.id})`,
                      description: `${item.builtin ? "Built-in" : "Custom"} · ${item.description || "No description"}`,
                    }))} />}
                  </details>
                  <SettingsButtonRow>
                    <NativeButton variant="outline" disabled={!data.revision || (hasCatalogConflict && data.revision === catalogConflict?.revision)}
                      onClick={() => { editor.rebaseToCurrent(); setCatalogConflict(null); }}>Apply draft to current personality</NativeButton>
                    <NativeButton variant="secondary" onClick={() => void reload()}>Reload latest catalog</NativeButton>
                  </SettingsButtonRow>
                </div> : null}
                <SettingsFieldGrid>
                  <SettingsField label="ID">
                    <input
                      className="mc-next-settings-input"
                      value={draft.id}
                      disabled={editorLocked || editingBuiltin || removePending}
                      onChange={(event) => updateDraft("id", event.target.value)}
                      placeholder="direct-operator"
                    />
                  </SettingsField>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={draft.label}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("label", event.target.value)}
                      placeholder="Direct Operator"
                    />
                  </SettingsField>
                  <SettingsField label="Category">
                    <select
                      className="mc-next-settings-input"
                      value={draft.category}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("category", event.target.value as PersonalityPresetCategory)}
                    >
                      {PERSONALITY_CATEGORY_OPTIONS.map((category) => (
                        <option key={category} value={category}>
                          {formatPersonalityCategoryLabel(category)}
                        </option>
                      ))}
                    </select>
                  </SettingsField>
                  <SettingsField label="Tone">
                    <input
                      className="mc-next-settings-input"
                      value={draft.tone}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("tone", event.target.value)}
                      placeholder="Composed"
                    />
                  </SettingsField>
                  <SettingsField label="Style">
                    <input
                      className="mc-next-settings-input"
                      value={draft.style}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("style", event.target.value)}
                      placeholder="Operational and compact"
                    />
                  </SettingsField>
                  <SettingsField label="Description" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.description}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("description", event.target.value)}
                      rows={3}
                    />
                  </SettingsField>
                  <SettingsField label="System overlay" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={draft.systemOverlay}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("systemOverlay", event.target.value)}
                      rows={7}
                    />
                  </SettingsField>
                  <SettingsField label="Safety notes" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.safetyNotes}
                      disabled={editorLocked || removePending}
                      onChange={(event) => updateDraft("safetyNotes", event.target.value)}
                      rows={4}
                    />
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message:
                      "Personality overlays affect Work tone and framing only; safety, privacy, memory, tools, approvals, and policy stay authoritative.",
                  }}
                />
                <SettingsButtonRow>
                  <NativeButton variant="default" onClick={() => void savePersonality()} disabled={!canSave || saving || editor.hasRemoteChanges || hasCatalogConflict || revisionUnavailable}>
                    <Save size={16} />
                    {editorMode === "new" ? "Create personality" : "Save edits"}
                  </NativeButton>
                  {editorMode === "selected" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => selectedPersonality && defaultSelection.requestReview(selectedPersonality.id)}
                      disabled={!selectedPersonality || !defaultSelection.ready || defaultSelection.locked}
                    >
                      <CheckCircle2 size={16} />
                      {selectedPersonality?.id === "default" ? "Clear Work default" : "Set as Work default"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "selected" && selectedPersonality?.id !== "default" ? (
                    <NativeButton
                      variant={selectedPersonality?.builtin ? "secondary" : "destructive"}
                      onClick={() =>
                        selectedPersonality
                          ? setPendingRemove({
                              id: selectedPersonality.id,
                              label: selectedPersonality.label,
                              builtin: selectedPersonality.builtin,
                              expectedRevision: data.revision,
                            })
                          : undefined
                      }
                      disabled={!data.revision || locked || saving || (selectedPersonality?.builtin === true && !selectedPersonality.modified)}
                    >
                      {selectedPersonality?.builtin ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                      {selectedPersonality?.builtin ? "Reset built-in" : "Remove custom"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "new" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={closeEditor}
                    >
                      <RotateCcw size={16} />
                      Cancel
                    </NativeButton>
                  ) : null}
                </SettingsButtonRow>
              </>
            ) : isDirty ? (
              <>
                <p role="status">The selected personality was removed. Your unsaved draft is retained for review.</p>
                <SettingsActionList ariaLabel="Retained personality draft" items={[
                  { label: "ID", description: draft.id },
                  { label: "Label", description: draft.label },
                  { label: "Category", description: formatPersonalityCategoryLabel(draft.category) },
                  { label: "Description", description: draft.description || "No description" },
                  { label: "Tone", description: draft.tone || "No tone" },
                  { label: "Style", description: draft.style || "No style" },
                  { label: "System overlay", description: draft.systemOverlay || "No overlay" },
                  { label: "Safety notes", description: draft.safetyNotes || "No extra safety notes" },
                ]} />
              </>
            ) : (
              <SettingsEmptyState label="Choose a personality or create a custom one." />
            )}
          </NativeCard></FocusedDetail> : null}
        </SettingsStack>
      ) : null}
      {leave.dialog}
      <ConfirmModal
        open={defaultSelection.review !== null}
        title="Change Work default?"
        message={`${defaultSelection.review?.preset.id === "default" ? "Clear the global Work personality and use the default voice?"
          : `Use the saved instructions for ${defaultSelection.review?.preset.label ?? "this personality"} as the global Work default?`} Catalog revision ${defaultSelection.review?.revision ?? "unavailable"}. ${PERSONALITY_DEFAULT_SCOPE}`}
        confirmLabel="Apply reviewed default"
        pending={defaultSelection.pending}
        confirmDisabled={!defaultSelection.reviewCurrent || defaultSelection.locked}
        onCancel={defaultSelection.cancel}
        onConfirm={() => void defaultSelection.confirm()}
      />
      <ConfirmModal
        open={pendingRemove !== null}
        danger={!pendingRemove?.builtin}
        pending={removePending}
        title={pendingRemove?.builtin ? "Reset built-in personality?" : "Remove custom personality?"}
        message={
          pendingRemove?.builtin
            ? `Reset ${pendingRemove.label} to the shipped preset? Local edits will be removed.`
            : `Remove ${pendingRemove?.label ?? "this personality"}? This cannot be undone.`
        }
        confirmLabel={pendingRemove?.builtin ? "Reset personality" : "Remove personality"}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => void removeOrResetPersonality()}
      />
    </SettingsSectionShell>
  );
}
