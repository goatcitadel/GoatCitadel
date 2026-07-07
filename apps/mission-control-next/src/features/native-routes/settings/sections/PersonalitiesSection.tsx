// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import type { PersonalityPresetCategory } from "@goatcitadel/contracts";
import {
  createPersonality,
  deletePersonality,
  fetchPersonalities,
  setDefaultPersonality,
  updatePersonality,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { useFormDirty } from "../../library/use-form-dirty";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList, StatusChip } from "../../primitives";
import {
  arePersonalityDraftsEqual,
  createEmptyPersonalityEditorDraft,
  createPersonalityEditorDraft,
  formatPersonalityCategoryLabel,
  formatPersonalityStatus,
  normalizePersonalityEditorId,
  personalityDraftToMutationInput,
  type PersonalityEditorDraft,
} from "../../SettingsNativePage";

const PERSONALITY_CATEGORY_OPTIONS: PersonalityPresetCategory[] = [
  "core",
  "critical",
  "execution",
  "social",
  "thinking",
  "flavor",
  "chaos",
];

export function PersonalitiesSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => fetchPersonalities(), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState("");
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [draft, setDraft] = useState<PersonalityEditorDraft>(() => createEmptyPersonalityEditorDraft());
  const selectedPersonality =
    data?.items?.find((item) => item.id === selectedPersonalityId) ?? data?.items?.[0] ?? null;
  const defaultPersonalityId = data?.defaultPersonalityId ?? "default";
  const customCount = data?.items?.filter((item) => !item.builtin).length ?? 0;
  const modifiedBuiltinCount = data?.items?.filter((item) => item.builtin && item.modified).length ?? 0;
  const editorLocked = editorMode === "selected" && (!selectedPersonality || selectedPersonality.editable === false);
  const editingBuiltin = editorMode === "selected" && selectedPersonality?.builtin === true;
  const canSave = editorMode === "new" || !editorLocked;

  // Ship punchlist H-9 (data integrity) — report this section's dirty state to
  // the shared registry so the page-level beforeunload + route-change guards
  // can warn the operator before edits are lost. The baseline is rebuilt from
  // the server snapshot, so a successful save (which triggers `reload()`)
  // naturally collapses dirty back to clean.
  const baselineDraft = useMemo(
    () =>
      editorMode === "new" ? createEmptyPersonalityEditorDraft() : createPersonalityEditorDraft(selectedPersonality),
    [editorMode, selectedPersonality],
  );
  const isDirty = !editorLocked && !arePersonalityDraftsEqual(draft, baselineDraft);
  useFormDirty("settings:personalities", isDirty, { label: "Personalities" });

  const confirmDiscardPersonalityChanges = useCallback(() => {
    if (!isDirty) {
      return true;
    }
    return (
      typeof window === "undefined" ||
      window.confirm("Discard unsaved personality changes before switching editor context?")
    );
  }, [isDirty]);

  useEffect(() => {
    if (!data?.items?.length) {
      setSelectedPersonalityId("");
      return;
    }
    setSelectedPersonalityId((current) =>
      current && data.items.some((item) => item.id === current) ? current : data.defaultPersonalityId,
    );
  }, [data?.defaultPersonalityId, data?.items]);

  useEffect(() => {
    if (editorMode === "new") {
      return;
    }
    setDraft(createPersonalityEditorDraft(selectedPersonality));
  }, [editorMode, selectedPersonality]);

  const beginCustomPersonality = () => {
    if (!confirmDiscardPersonalityChanges()) {
      return;
    }
    setEditorMode("new");
    setDraft(createEmptyPersonalityEditorDraft());
    setNotice(null);
  };

  const refreshPersonalities = () => {
    if (!confirmDiscardPersonalityChanges()) {
      return;
    }
    setEditorMode("selected");
    void reload();
  };

  const savePersonality = async () => {
    const input = personalityDraftToMutationInput(draft);
    if (!input.label) {
      setNotice({ tone: "warning", message: "Personality label is required." });
      return;
    }
    try {
      if (editorMode === "new") {
        const nextId = normalizePersonalityEditorId(input.id || input.label);
        await createPersonality(input);
        setNotice({ tone: "success", message: "Custom personality created." });
        await reload();
        setEditorMode("selected");
        setSelectedPersonalityId(nextId);
        return;
      }
      if (!selectedPersonality || selectedPersonality.editable === false) {
        setNotice({ tone: "warning", message: "This personality cannot be edited." });
        return;
      }
      const nextId = selectedPersonality.builtin
        ? selectedPersonality.id
        : normalizePersonalityEditorId(input.id || selectedPersonality.id);
      await updatePersonality(selectedPersonality.id, input);
      setNotice({ tone: "success", message: `${selectedPersonality.label} saved.` });
      await reload();
      setSelectedPersonalityId(nextId);
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const makeDefault = async () => {
    if (!selectedPersonality) {
      return;
    }
    try {
      await setDefaultPersonality(selectedPersonality.id);
      setNotice({
        tone: "success",
        message:
          selectedPersonality.id === "default"
            ? "Work personality cleared."
            : `${selectedPersonality.label} is now the global Work default.`,
      });
      await reload();
    } catch (defaultError) {
      setNotice({ tone: "error", message: getErrorMessage(defaultError) });
    }
  };

  const removeOrResetPersonality = async () => {
    if (!selectedPersonality || selectedPersonality.id === "default") {
      return;
    }
    if (!selectedPersonality.builtin && !window.confirm(`Remove ${selectedPersonality.label}?`)) {
      return;
    }
    try {
      await deletePersonality(selectedPersonality.id);
      setNotice({
        tone: "success",
        message: selectedPersonality.builtin
          ? `${selectedPersonality.label} reset to the shipped preset.`
          : `${selectedPersonality.label} removed.`,
      });
      await reload();
      setSelectedPersonalityId(selectedPersonality.builtin ? selectedPersonality.id : "default");
      setEditorMode("selected");
    } catch (removeError) {
      setNotice({ tone: "error", message: getErrorMessage(removeError) });
    }
  };

  const updateDraft = <K extends keyof PersonalityEditorDraft>(key: K, value: PersonalityEditorDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {/* F-M11: personalities is an experimental surface. Beyond the page-frame
          badge, state it inline since this section's labeling was the weakest. */}
      <p className="mc-next-settings-experimental-note" role="note">
        <strong>Experimental.</strong> Work personalities are an experimental surface and may change before 1.0.
      </p>
      {data ? (
        <SettingsGrid variant="detail-wide">
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Personality catalog"
            subtitle="Built-in presets, custom overlays, and the global Work default."
            scrollBody
            bodyMaxHeight="min(64vh, 38rem)"
            stats={[
              { label: "Presets", value: String(data.items?.length ?? 0) },
              { label: "Custom", value: String(customCount) },
              { label: "Modified", value: String(modifiedBuiltinCount) },
            ]}
          >
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={beginCustomPersonality}>
                <Plus size={16} />
                Add custom personality
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
                meta: formatPersonalityStatus(item, defaultPersonalityId),
                body: `${formatPersonalityCategoryLabel(item.category)} · ${item.tone || "No tone"} · ${
                  item.description || "No description"
                }`,
              }))}
              selectedId={editorMode === "new" ? "" : selectedPersonalityId}
              onSelect={(id) => {
                if (!confirmDiscardPersonalityChanges()) {
                  return;
                }
                setEditorMode("selected");
                setSelectedPersonalityId(id);
              }}
              emptyLabel="No personalities returned from the gateway."
              maxHeight="min(48vh, 28rem)"
            />
          </NativeCard>
          <NativeCard
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
                <SettingsFieldGrid>
                  <SettingsField label="ID">
                    <input
                      className="mc-next-settings-input"
                      value={draft.id}
                      disabled={editorLocked || editingBuiltin}
                      onChange={(event) => updateDraft("id", event.target.value)}
                      placeholder="direct-operator"
                    />
                  </SettingsField>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={draft.label}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("label", event.target.value)}
                      placeholder="Direct Operator"
                    />
                  </SettingsField>
                  <SettingsField label="Category">
                    <select
                      className="mc-next-settings-input"
                      value={draft.category}
                      disabled={editorLocked}
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
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("tone", event.target.value)}
                      placeholder="Composed"
                    />
                  </SettingsField>
                  <SettingsField label="Style">
                    <input
                      className="mc-next-settings-input"
                      value={draft.style}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("style", event.target.value)}
                      placeholder="Operational and compact"
                    />
                  </SettingsField>
                  <SettingsField label="Description" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.description}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("description", event.target.value)}
                      rows={3}
                    />
                  </SettingsField>
                  <SettingsField label="System overlay" span={2}>
                    <textarea
                      className="mc-next-settings-textarea mc-next-settings-code"
                      value={draft.systemOverlay}
                      disabled={editorLocked}
                      onChange={(event) => updateDraft("systemOverlay", event.target.value)}
                      rows={7}
                    />
                  </SettingsField>
                  <SettingsField label="Safety notes" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.safetyNotes}
                      disabled={editorLocked}
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
                  <NativeButton variant="default" onClick={() => void savePersonality()} disabled={!canSave}>
                    <Save size={16} />
                    {editorMode === "new" ? "Create personality" : "Save edits"}
                  </NativeButton>
                  {editorMode === "selected" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => void makeDefault()}
                      disabled={!selectedPersonality}
                    >
                      <CheckCircle2 size={16} />
                      {selectedPersonality?.id === "default" ? "Clear Work default" : "Set as Work default"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "selected" && selectedPersonality?.id !== "default" ? (
                    <NativeButton
                      variant={selectedPersonality?.builtin ? "secondary" : "destructive"}
                      onClick={() => void removeOrResetPersonality()}
                      disabled={selectedPersonality?.builtin === true && !selectedPersonality.modified}
                    >
                      {selectedPersonality?.builtin ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                      {selectedPersonality?.builtin ? "Reset built-in" : "Remove custom"}
                    </NativeButton>
                  ) : null}
                  {editorMode === "new" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => {
                        setEditorMode("selected");
                        setDraft(createPersonalityEditorDraft(selectedPersonality));
                      }}
                    >
                      <RotateCcw size={16} />
                      Cancel
                    </NativeButton>
                  ) : null}
                </SettingsButtonRow>
              </>
            ) : (
              <SettingsEmptyState label="Choose a personality or create a custom one." />
            )}
          </NativeCard>
        </SettingsGrid>
      ) : null}
    </SettingsSectionShell>
  );
}
