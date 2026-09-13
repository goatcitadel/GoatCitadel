// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useRef, useState } from "react";
import { CheckCircle2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import type { PersonalityPresetCategory } from "@goatcitadel/contracts";
import {
  createPersonality,
  deletePersonality,
  fetchPersonalities,
  isApiRequestError,
  setDefaultPersonality,
  updatePersonality,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsActionList,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsStack,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  useAsyncLoad,
} from "../SettingsShared";
import { useSessionDraft, hasSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList, StatusChip } from "../../primitives";
import {
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

type PersonalityTransition = { kind: "select"; id: string } | { kind: "new" } | { kind: "refresh" };

export function PersonalitiesSection(_props: SettingsSectionProps) {
  const load = useCallback(async () => fetchPersonalities(), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState("");
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [catalogConflict, setCatalogConflict] = useState<{ key: string; revision: string } | null>(null);
  const [pendingDefault, setPendingDefault] = useState<{ id: string; label: string; expectedRevision: string } | null>(null);
  const [defaultPending, setDefaultPending] = useState(false);
  const defaultPendingRef = useRef(false);
  const removePendingRef = useRef(false);
  const leave = useDraftLeave();
  const [pendingRemove, setPendingRemove] = useState<{
    id: string;
    label: string;
    builtin: boolean;
    expectedRevision: string;
  } | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const selectedPersonality =
    data?.items?.find((item) => item.id === selectedPersonalityId) ?? null;
  const defaultPersonalityId = data?.defaultPersonalityId ?? "default";
  const customCount = data?.items?.filter((item) => !item.builtin).length ?? 0;
  const modifiedBuiltinCount = data?.items?.filter((item) => item.builtin && item.modified).length ?? 0;
  const editorLocked = editorMode === "selected" && (!selectedPersonality || selectedPersonality.editable === false);
  const editingBuiltin = editorMode === "selected" && selectedPersonality?.builtin === true;
  const canSave = editorMode === "new" || !editorLocked;

  const baseline = editorMode === "new" ? createEmptyPersonalityEditorDraft() : createPersonalityEditorDraft(selectedPersonality);
  const editor = useSessionDraft(`personality:system:${editorMode === "new" ? "new" : selectedPersonalityId}`, baseline, data?.revision, {
    label: editorMode === "new" ? "New personality" : selectedPersonality?.label ?? "Personality",
    active: editorOpen, available: editorMode === "new" || Boolean(selectedPersonality), onSave: () => savePersonality(),
  });
  const draft = editor.value;
  const setDraft = editor.setValue;
  const isDirty = editor.isDirty;
  const hasCatalogConflict = catalogConflict?.key === editor.key;
  const revisionUnavailable = typeof editor.baseRevision !== "string";
  const closeEditor = () => leave.request(() => setEditorOpen(false), [editor.key]);
  const personalityTransitionGuard = { requestTransition: (transition: PersonalityTransition) => {
    if (transition.kind === "refresh") { void reload(); return; }
    leave.request(() => {
      setEditorMode(transition.kind === "new" ? "new" : "selected");
      if (transition.kind === "select") setSelectedPersonalityId(transition.id);
      setEditorOpen(true); setNotice(null);
    }, [editor.key]);
  } };

  const beginCustomPersonality = () => {
    if (editorMode === "new" && editorOpen) {
      return;
    }
    personalityTransitionGuard.requestTransition({ kind: "new" });
  };

  const refreshPersonalities = () => {
    personalityTransitionGuard.requestTransition({ kind: "refresh" });
  };

  const savePersonality = async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (editor.hasRemoteChanges || hasCatalogConflict) { setNotice({ tone: "warning", message: "The personality catalog changed. Review it before applying your draft." }); return false; }
    const expectedRevision = editor.baseRevision;
    if (typeof expectedRevision !== "string") { setNotice({ tone: "warning", message: "Reload the personality catalog before saving." }); return false; }
    const submitted = draft;
    const input = personalityDraftToMutationInput(draft);
    if (!input.label) {
      setNotice({ tone: "warning", message: "Personality label is required." });
      return false;
    }
    try {
      savingRef.current = true; setSaving(true);
      if (editorMode === "new") {
        const nextId = normalizePersonalityEditorId(input.id || input.label);
        const saved = await createPersonality({ ...input, expectedRevision });
        const savedPreset = saved.items.find((item) => item.id === nextId);
        const clean = editor.acceptSavedAs(`personality:system:${nextId}`,
          savedPreset ? createPersonalityEditorDraft(savedPreset) : submitted, saved.revision, submitted);
        setCatalogConflict(null);
        setNotice({ tone: "success", message: "Custom personality created." });
        setEditorMode("selected"); setSelectedPersonalityId(nextId);
        await reload();
        if (clean) setEditorOpen(false);
        return clean;
      }
      if (!selectedPersonality || selectedPersonality.editable === false) {
        setNotice({ tone: "warning", message: "This personality cannot be edited." });
        return false;
      }
      const nextId = selectedPersonality.builtin
        ? selectedPersonality.id
        : normalizePersonalityEditorId(input.id || selectedPersonality.id);
      const saved = await updatePersonality(selectedPersonality.id, { ...input, expectedRevision });
      const savedPreset = saved.items.find((item) => item.id === nextId);
      const clean = editor.acceptSavedAs(`personality:system:${nextId}`,
        savedPreset ? createPersonalityEditorDraft(savedPreset) : submitted, saved.revision, submitted);
      setCatalogConflict(null);
      setNotice({ tone: "success", message: `${selectedPersonality.label} saved.` });
      setSelectedPersonalityId(nextId);
      await reload();
      return clean;
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        setCatalogConflict({ key: editor.key, revision: expectedRevision });
        setNotice({ tone: "warning", message: "The personality catalog changed. Your draft is preserved; review the current catalog before saving again." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const makeDefault = async () => {
    if (!pendingDefault || defaultPendingRef.current) {
      return;
    }
    defaultPendingRef.current = true; setDefaultPending(true);
    try {
      await setDefaultPersonality(pendingDefault.id, pendingDefault.expectedRevision);
      setNotice({
        tone: "success",
        message:
          pendingDefault.id === "default"
            ? "Work personality cleared."
            : `${pendingDefault.label} is now the global Work default.`,
      });
      setPendingDefault(null);
      await reload();
    } catch (defaultError) {
      setPendingDefault(null);
      if (isApiRequestError(defaultError) && defaultError.status === 409) {
        setNotice({ tone: "warning", message: "The personality catalog changed. Review it again before setting the Work default." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(defaultError) });
    } finally { defaultPendingRef.current = false; setDefaultPending(false); }
  };

  const removeOrResetPersonality = async () => {
    if (!pendingRemove || removePendingRef.current) {
      return;
    }
    removePendingRef.current = true; setRemovePending(true);
    try {
      await deletePersonality(pendingRemove.id, pendingRemove.expectedRevision);
      setNotice({
        tone: "success",
        message: pendingRemove.builtin
          ? `${pendingRemove.label} reset to the shipped preset.`
          : `${pendingRemove.label} removed.`,
      });
      const nextSelectedId = pendingRemove.builtin ? pendingRemove.id : "default";
      editor.discard();
      setEditorOpen(false);
      setSelectedPersonalityId(nextSelectedId);
      setEditorMode("selected");
      setPendingRemove(null);
      await reload();
    } catch (removeError) {
      setPendingRemove(null);
      if (isApiRequestError(removeError) && removeError.status === 409) {
        setNotice({ tone: "warning", message: "The personality catalog changed. Your draft is preserved; review it again before resetting or removing a personality." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(removeError) });
    } finally {
      removePendingRef.current = false; setRemovePending(false);
    }
  };

  const updateDraft = <K extends keyof PersonalityEditorDraft>(key: K, value: PersonalityEditorDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
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
              <NativeButton variant="default" onClick={beginCustomPersonality}>
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
                    <NativeButton variant="outline" disabled={!data.revision || (hasCatalogConflict && data.revision === catalogConflict.revision)}
                      onClick={() => { editor.rebaseToCurrent(); setCatalogConflict(null); }}>Apply draft to current personality</NativeButton>
                    <NativeButton variant="secondary" onClick={() => void reload()}>Reload latest catalog</NativeButton>
                  </SettingsButtonRow>
                </div> : null}
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
                  <NativeButton variant="default" onClick={() => void savePersonality()} disabled={!canSave || saving || editor.hasRemoteChanges || hasCatalogConflict || revisionUnavailable}>
                    <Save size={16} />
                    {editorMode === "new" ? "Create personality" : "Save edits"}
                  </NativeButton>
                  {editorMode === "selected" ? (
                    <NativeButton
                      variant="secondary"
                      onClick={() => selectedPersonality && data.revision && setPendingDefault({ id: selectedPersonality.id,
                        label: selectedPersonality.label, expectedRevision: data.revision })}
                      disabled={!selectedPersonality || !data.revision || saving}
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
                      disabled={!data.revision || saving || (selectedPersonality?.builtin === true && !selectedPersonality.modified)}
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
        open={pendingDefault !== null}
        title="Change Work default?"
        message={pendingDefault?.id === "default" ? "Clear the global Work personality and use the default voice?"
          : `Use the saved instructions for ${pendingDefault?.label ?? "this personality"} as the global Work default?`}
        confirmLabel="Apply reviewed default"
        pending={defaultPending}
        onCancel={() => setPendingDefault(null)}
        onConfirm={() => void makeDefault()}
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
