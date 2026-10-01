import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPersonality,
  deletePersonality,
  fetchPersonalities,
  updatePersonality,
} from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage, type Notice, useAsyncLoad } from "../shared/native-helpers";
import { useSessionDraft } from "../library/session-drafts";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { hasPersonalityCatalog, usePersonalityDefault } from "./use-personality-default";
import {
  beginPersonalityEdit,
  confirmedPersonalityEdit,
  finishPersonalityEdit,
  isPersonalityPrecommitConflict,
  personalityDraftMatches,
  retainPersonalityEditUncertainty,
  usePersonalityEditorMutation,
} from "./personality-editor-mutation";
import {
  createEmptyPersonalityEditorDraft,
  createPersonalityEditorDraft,
  normalizePersonalityEditorId,
  personalityDraftToMutationInput,
  type PersonalityEditorDraft,
} from "./helpers/personality-helpers";

type PersonalityTransition = { kind: "select"; id: string } | { kind: "new" } | { kind: "refresh" };

/** One retained-draft and revision-aware editor lifecycle for both Settings presentations. */
export function usePersonalityEditor() {
  const load = useCallback(async () => fetchPersonalities(), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedPersonalityId, setSelectedPersonalityId] = useState("");
  const [editorMode, setEditorMode] = useState<"selected" | "new">("selected");
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const mutation = usePersonalityEditorMutation();
  const [catalogConflict, setCatalogConflict] = useState<{ key: string; revision: string } | null>(null);
  const removePendingRef = useRef(false);
  const leave = useDraftLeave();
  const [pendingRemove, setPendingRemove] = useState<{
    id: string;
    label: string;
    builtin: boolean;
    expectedRevision: string;
  } | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const available = !loading && !error && hasPersonalityCatalog(data ?? undefined);
  const defaultSelection = usePersonalityDefault({
    catalog: data ?? undefined,
    available: available && !mutation.pending && !mutation.uncertain,
    reload,
  });
  const selectedPersonality = data?.items?.find((item) => item.id === selectedPersonalityId) ?? null;
  const defaultPersonalityId = data?.defaultPersonalityId ?? "default";
  const customCount = data?.items?.filter((item) => !item.builtin).length ?? 0;
  const modifiedBuiltinCount = data?.items?.filter((item) => item.builtin && item.modified).length ?? 0;
  const editorLocked =
    editorMode === "selected" &&
    (!selectedPersonality || selectedPersonality.id === "default" || selectedPersonality.editable === false);
  const editingBuiltin = editorMode === "selected" && selectedPersonality?.builtin === true;
  const locked = mutation.pending || Boolean(mutation.uncertain) || defaultSelection.locked;
  const canSave = (editorMode === "new" || !editorLocked) && available && !locked;

  const baseline =
    editorMode === "new" ? createEmptyPersonalityEditorDraft() : createPersonalityEditorDraft(selectedPersonality);
  const editor = useSessionDraft(
    `personality:system:${editorMode === "new" ? "new" : selectedPersonalityId}`,
    baseline,
    data?.revision,
    {
      label: editorMode === "new" ? "New personality" : (selectedPersonality?.label ?? "Personality"),
      active: editorOpen,
      available: available && (editorMode === "new" || Boolean(selectedPersonality)),
      onSave: () => savePersonality(),
    },
  );
  const draft = editor.value;
  const setDraft = editor.setValue;
  const isDirty = editor.isDirty;
  const hasCatalogConflict = catalogConflict?.key === editor.key;
  const revisionUnavailable = typeof editor.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(editor.baseRevision);
  const closeEditor = () =>
    leave.request(() => {
      generation.current += 1;
      setEditorOpen(false);
    }, [editor.key]);
  const personalityTransitionGuard = {
    requestTransition: (transition: PersonalityTransition) => {
      if (transition.kind === "refresh") {
        void reload();
        return;
      }
      leave.request(() => {
        generation.current += 1;
        setEditorMode(transition.kind === "new" ? "new" : "selected");
        if (transition.kind === "select") setSelectedPersonalityId(transition.id);
        setEditorOpen(true);
        setNotice(null);
      }, [editor.key]);
    },
  };

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
    if (editorLocked) {
      setNotice({ tone: "warning", message: "This personality cannot be edited." });
      return false;
    }
    if (!canSave) return false;
    if (editor.hasRemoteChanges || hasCatalogConflict) {
      setNotice({ tone: "warning", message: "The personality catalog changed. Review it before applying your draft." });
      return false;
    }
    const expectedRevision = editor.baseRevision;
    if (typeof expectedRevision !== "string" || revisionUnavailable) {
      setNotice({ tone: "warning", message: "Reload the personality catalog before saving." });
      return false;
    }
    const submitted = draft;
    const input = personalityDraftToMutationInput(draft);
    if (!input.label) {
      setNotice({ tone: "warning", message: "Personality label is required." });
      return false;
    }
    if (!beginPersonalityEdit()) return false;
    const started = generation.current;
    const isCurrent = () => mounted.current && generation.current === started;
    try {
      savingRef.current = true;
      setSaving(true);
      if (editorMode === "new") {
        const nextId = normalizePersonalityEditorId(input.id || input.label);
        const saved = await createPersonality({ ...input, expectedRevision });
        const savedPreset = confirmedPersonalityEdit(saved, nextId, expectedRevision);
        if (savedPreset.builtin || !personalityDraftMatches(savedPreset, submitted))
          throw new Error("The saved personality differs from the submitted draft.");
        const clean = editor.acceptSavedAs(
          `personality:system:${nextId}`,
          createPersonalityEditorDraft(savedPreset),
          saved.revision,
          submitted,
        );
        if (!isCurrent()) {
          if (mounted.current) await reload();
          return false;
        }
        setCatalogConflict(null);
        setNotice({ tone: "success", message: "Custom personality created." });
        setEditorMode("selected");
        setSelectedPersonalityId(nextId);
        await reload();
        if (clean && isCurrent()) setEditorOpen(false);
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
      const savedPreset = confirmedPersonalityEdit(saved, nextId, expectedRevision);
      if (
        savedPreset.builtin !== selectedPersonality.builtin ||
        !personalityDraftMatches(savedPreset, submitted) ||
        (nextId !== selectedPersonality.id && saved.items.some((item) => item.id === selectedPersonality.id))
      )
        throw new Error("The saved personality differs from the submitted draft.");
      const clean = editor.acceptSavedAs(
        `personality:system:${nextId}`,
        createPersonalityEditorDraft(savedPreset),
        saved.revision,
        submitted,
      );
      if (!isCurrent()) {
        if (mounted.current) await reload();
        return false;
      }
      setCatalogConflict(null);
      setNotice({ tone: "success", message: `${selectedPersonality.label} saved.` });
      setSelectedPersonalityId(nextId);
      await reload();
      return clean;
    } catch (saveError) {
      if (isPersonalityPrecommitConflict(saveError)) {
        if (!isCurrent()) return false;
        setCatalogConflict({ key: editor.key, revision: expectedRevision });
        setNotice({
          tone: "warning",
          message:
            "The personality catalog changed. Your draft is preserved; review the current catalog before saving again.",
        });
        await reload();
      } else {
        retainPersonalityEditUncertainty(getErrorMessage(saveError));
        if (isCurrent()) setNotice({ tone: "error", message: getErrorMessage(saveError) });
      }
      return false;
    } finally {
      savingRef.current = false;
      finishPersonalityEdit();
      if (mounted.current) setSaving(false);
    }
  };

  const removeOrResetPersonality = async () => {
    if (
      !pendingRemove ||
      removePendingRef.current ||
      locked ||
      !available ||
      data?.revision !== pendingRemove.expectedRevision
    ) {
      return;
    }
    if (!beginPersonalityEdit()) return;
    const started = generation.current,
      intent = pendingRemove;
    const isCurrent = () => mounted.current && generation.current === started;
    removePendingRef.current = true;
    setRemovePending(true);
    try {
      const saved = await deletePersonality(intent.id, intent.expectedRevision);
      if (
        !hasPersonalityCatalog(saved) ||
        saved.revision === intent.expectedRevision ||
        (intent.builtin
          ? !saved.items.some((item) => item.id === intent.id && item.builtin && !item.modified)
          : saved.items.some((item) => item.id === intent.id))
      )
        throw new Error("The Gateway did not confirm the reviewed removal or reset.");
      if (!isCurrent()) {
        if (mounted.current) await reload();
        return;
      }
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
      if (isCurrent()) setPendingRemove(null);
      if (isPersonalityPrecommitConflict(removeError)) {
        if (!isCurrent()) return;
        setNotice({
          tone: "warning",
          message:
            "The personality catalog changed. Your draft is preserved; review it again before resetting or removing a personality.",
        });
        await reload();
      } else {
        retainPersonalityEditUncertainty(getErrorMessage(removeError));
        if (isCurrent()) setNotice({ tone: "error", message: getErrorMessage(removeError) });
      }
    } finally {
      removePendingRef.current = false;
      finishPersonalityEdit();
      if (mounted.current) setRemovePending(false);
    }
  };

  const updateDraft = <K extends keyof PersonalityEditorDraft>(key: K, value: PersonalityEditorDraft[K]) => {
    if (removePendingRef.current) return;
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return {
    loading,
    error,
    data,
    reload,
    notice,
    available,
    locked,
    mutation,
    selectedPersonalityId,
    editorMode,
    editorOpen,
    saving,
    catalogConflict,
    setCatalogConflict,
    pendingRemove,
    setPendingRemove,
    removePending,
    defaultSelection,
    selectedPersonality,
    defaultPersonalityId,
    customCount,
    modifiedBuiltinCount,
    editorLocked,
    editingBuiltin,
    canSave,
    editor,
    draft,
    isDirty,
    hasCatalogConflict,
    revisionUnavailable,
    closeEditor,
    personalityTransitionGuard,
    beginCustomPersonality,
    refreshPersonalities,
    savePersonality,
    removeOrResetPersonality,
    updateDraft,
    leave,
  };
}
