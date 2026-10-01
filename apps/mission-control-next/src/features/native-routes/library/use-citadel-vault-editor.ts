import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import {
  deleteCitadelVaultSecret,
  getCitadelVaultSnapshot,
  revealCitadelVaultSecret,
  storeCitadelVaultSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import { describeVaultError, useCitadelVaultReview } from "./useCitadelVaultReview";
import { hasVaultSnapshot, sameVaultValue } from "./citadel-vault-binding";

const EMPTY_SECRET = { name: "", value: "" };
/** Shares only app-session input; plaintext never enters review or admission registries. */
export function useCitadelVaultEditor(citadelId: string) {
  const vault = useCitadelVaultReview(citadelId);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const leave = useDraftLeave();
  const secretDraft = useSessionDraft(`vault-secret:${vault.key}:new`, EMPTY_SECRET, vault.snapshot?.revision, {
    label: "New secret",
    active: formOpen,
    available: Boolean(vault.snapshot),
    onSave: (): Promise<boolean> => store(),
  });
  const draft = secretDraft.value;
  const [pendingStore, setPendingStore] = useState<{ draft: typeof EMPTY_SECRET; revision: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; revision: string } | null>(null);
  const revealGeneration = useRef(0),
    actionGeneration = useRef(0);
  const renderedGeneration = actionGeneration.current;
  const setDraft = (update: SetStateAction<typeof EMPTY_SECRET>) => {
    actionGeneration.current += 1;
    setPendingStore(null);
    setPendingDelete(null);
    secretDraft.setValue(update);
  };
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const reviewRequired = vault.reviewRequired || secretDraft.hasRemoteChanges;
  const canStore = vault.ready && !reviewRequired && !pendingStore;
  const items = vault.snapshot?.items ?? [];
  const selectedSecret = items.find((item) => item.secretId === selectedSecretId);
  const clearReveals = useCallback(() => {
    revealGeneration.current += 1;
    setRevealed({});
    setRevealErrors({});
  }, []);
  useEffect(() => {
    clearReveals();
    setFormOpen(false);
    setSelectedSecretId(null);
    setPendingDelete(null);
    setPendingStore(null);
    return () => {
      revealGeneration.current += 1;
      actionGeneration.current += 1;
    };
  }, [vault.key, clearReveals]);

  const save = async (submitted: typeof EMPTY_SECRET, revision: string) => {
    if (renderedGeneration !== actionGeneration.current) return false;
    const captured = { ...submitted },
      generation = renderedGeneration;
    let draftClean = false;
    const saved = await vault.run(
      revision,
      () => storeCitadelVaultSecret(citadelId, captured.name.trim(), captured.value, revision),
      {
        change: { type: "store", name: captured.name.trim() },
        isReviewCurrent: () => actionGeneration.current === generation,
        onConfirmed: (receipt) => {
          draftClean = secretDraft.acceptSaved(EMPTY_SECRET, receipt.revision, captured);
        },
      },
    );
    if (!vault.isCurrent() || actionGeneration.current !== generation) return false;
    setPendingStore(null);
    clearReveals();
    if (!saved) return false;
    if (draftClean) setFormOpen(false);
    return true;
  };
  const store = async () => {
    if (renderedGeneration !== actionGeneration.current) return false;
    const revision = secretDraft.baseRevision;
    if (!canStore || typeof revision !== "string" || !draft.name.trim() || !draft.value) return false;
    if (items.some((item) => item.secretName === draft.name.trim())) {
      setPendingStore({ draft: { ...draft }, revision });
      return false;
    }
    return await save(draft, revision);
  };
  const remove = async () => {
    if (!pendingDelete || renderedGeneration !== actionGeneration.current) return;
    const reviewed = pendingDelete,
      generation = renderedGeneration;
    const saved = await vault.run(
      reviewed.revision,
      () => deleteCitadelVaultSecret(citadelId, reviewed.id, reviewed.revision),
      {
        change: { type: "delete", secretId: reviewed.id },
        isReviewCurrent: () => actionGeneration.current === generation,
        onConfirmed: (receipt) => {
          if (!secretDraft.isDirty) secretDraft.acceptSaved(EMPTY_SECRET, receipt.revision);
        },
      },
    );
    if (!vault.isCurrent() || actionGeneration.current !== generation) return;
    setPendingDelete(null);
    clearReveals();
    if (saved) setSelectedSecretId(null);
  };
  const reveal = async (secretId: string) => {
    const generation = ++revealGeneration.current;
    setRevealed({});
    setRevealErrors({});
    const current = () => vault.isCurrent() && generation === revealGeneration.current;
    try {
      const before = await getCitadelVaultSnapshot(citadelId);
      if (!current()) return;
      if (
        !hasVaultSnapshot(before, citadelId) ||
        !before.items.some((item) => item.secretId === secretId) ||
        !sameVaultValue(before, vault.snapshot)
      )
        throw new Error("Changed metadata");
      const value = await revealCitadelVaultSecret(citadelId, secretId);
      if (!current()) return;
      const after = await getCitadelVaultSnapshot(citadelId);
      if (!current()) return;
      if (typeof value !== "string" || !hasVaultSnapshot(after, citadelId) || !sameVaultValue(before, after))
        throw new Error("Changed metadata");
      setRevealed({ [secretId]: value });
    } catch (error) {
      if (current()) setRevealErrors({ [secretId]: describeVaultError(error) });
    }
  };
  useEffect(() => {
    if (!Object.keys(revealed).length) return;
    const timer = globalThis.setTimeout(clearReveals, 30_000);
    return () => globalThis.clearTimeout(timer);
  }, [clearReveals, revealed]);
  const closeDetails = () =>
    leave.request(() => {
      actionGeneration.current += 1;
      clearReveals();
      setFormOpen(false);
      setSelectedSecretId(null);
      setPendingStore(null);
      setPendingDelete(null);
    }, [secretDraft.key]);
  const openForm = () =>
    leave.request(() => {
      actionGeneration.current += 1;
      clearReveals();
      setSelectedSecretId(null);
      setFormOpen(true);
    }, [secretDraft.key]);
  const inspect = (id: string) =>
    leave.request(() => {
      actionGeneration.current += 1;
      clearReveals();
      setFormOpen(false);
      setSelectedSecretId(id);
    }, [secretDraft.key]);
  const reviewDelete = () => {
    if (selectedSecret && vault.snapshot && vault.ready && !reviewRequired)
      setPendingDelete({
        id: selectedSecret.secretId,
        name: selectedSecret.secretName,
        revision: vault.snapshot.revision,
      });
  };
  return {
    vault,
    formOpen,
    secretDraft,
    draft,
    setDraft,
    pendingStore,
    pendingDelete,
    revealed,
    revealErrors,
    busy: vault.busy,
    reviewRequired,
    canStore,
    items,
    selectedSecret,
    leave,
    clearReveals,
    closeDetails,
    openForm,
    inspect,
    reviewDelete,
    save,
    store,
    remove,
    reveal,
    cancelStore: () => {
      actionGeneration.current += 1;
      setPendingStore(null);
    },
    cancelDelete: () => {
      actionGeneration.current += 1;
      setPendingDelete(null);
    },
    acceptReview: () => {
      secretDraft.rebaseToCurrent();
      vault.acceptReview();
    },
    refresh: () => {
      actionGeneration.current += 1;
      clearReveals();
      return vault.reload();
    },
  };
}
