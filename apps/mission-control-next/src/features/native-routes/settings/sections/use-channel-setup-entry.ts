import { useEffect, useRef, useState } from "react";
import type { ChannelOAuthAttempt, ChannelSetupDiscoveryResult, ChannelSetupDraft } from "@goatcitadel/contracts";
import { createChannelSetupDraft, fetchChannelSetupDraft } from "@goatcitadel/mission-control-shared/api/client";
import { startStagedSlackOAuth, fetchChannelOAuthAttempt, adoptSlackOAuthInstall, cancelChannelOAuthAttempt } from "@goatcitadel/mission-control-shared/api/channel-oauth";
import { discoverTelegramSetupTargets } from "@goatcitadel/mission-control-shared/api/channel-setup-operations";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { formatJson, readDraftString } from "../helpers/input-format";
import { mergeDiscoveredChannelTargets, readChannelTargetRows } from "../channel-setup/channel-wizard-model";
import { getErrorMessage } from "../SettingsShared";
import { assertChannelDraft, beginChannelOperation } from "./channel-setup-state";
import type { ChannelSetupState } from "./use-channel-setup-state";

export function useChannelSetupEntry(s: ChannelSetupState, saveDraft?: () => Promise<ChannelSetupDraft | undefined>) {
  const [entryBusy, setEntryBusy] = useState(false);
  const [oauthAttemptId, setOAuthAttemptId] = useSessionViewState("channel-oauth:" + s.activeWorkspaceId + ":" + s.selectedDraftId, "");
  const [oauthAttempt, setOAuthAttempt] = useState<ChannelOAuthAttempt | null>(null);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{ result: ChannelSetupDiscoveryResult; draftId: string; revision: number; epoch: number } | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Record<string, boolean>>({});
  const current = useRef({ draftId: s.selectedDraftId, workspaceId: s.activeWorkspaceId });
  current.current = { draftId: s.selectedDraftId, workspaceId: s.activeWorkspaceId };
  const selectedScope = s.activeWorkspaceId + ":" + s.selectedDraftId;
  useEffect(() => {
    setOAuthAttempt(null); setOAuthError(null); setAuthorizationUrl(null);
    setDiscovery(null); setSelectedCandidates({});
  }, [selectedScope]);
  function assertAttempt(attempt: ChannelOAuthAttempt) {
    if (attempt.provider !== "slack" || attempt.workspaceId !== s.activeWorkspaceId ||
      attempt.draftId !== s.selectedDraftId || !Number.isSafeInteger(attempt.revision) || attempt.revision < 1)
      throw new Error("The OAuth receipt does not belong to this workspace and channel draft.");
  }
  // The poll reads the render-current receipt check without restarting on every render.
  const assertAttemptRef = useRef(assertAttempt);
  assertAttemptRef.current = assertAttempt;
  const selectedCatalogId = s.selectedDraft?.catalogId;
  const refreshOAuthAttempt = async () => {
    if (!oauthAttemptId || s.selectedDraft?.catalogId !== "channel.slack") return;
    try {
      const attempt = await fetchChannelOAuthAttempt({ workspaceId: s.activeWorkspaceId, attemptId: oauthAttemptId });
      if (!s.isCurrentDraft()) return;
      assertAttempt(attempt);
      if (attempt.attemptId !== oauthAttemptId) throw new Error("The OAuth attempt identity changed.");
      setOAuthAttempt(attempt); setOAuthError(null);
    } catch (cause) { if (s.isCurrentDraft()) setOAuthError(getErrorMessage(cause)); }
  };
  useEffect(() => {
    if (!oauthAttemptId || selectedCatalogId !== "channel.slack") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const scope = { ...current.current };
    const refresh = async () => {
      try {
        const attempt = await fetchChannelOAuthAttempt({ workspaceId: scope.workspaceId, attemptId: oauthAttemptId });
        if (!active || current.current.draftId !== scope.draftId || current.current.workspaceId !== scope.workspaceId) return;
        assertAttemptRef.current(attempt);
        if (attempt.attemptId !== oauthAttemptId) throw new Error("The OAuth attempt identity changed.");
        setOAuthAttempt(attempt); setOAuthError(null);
        if ((attempt.status === "pending" || attempt.status === "exchanging") && ++polls < 30) timer = setTimeout(() => void refresh(), 2000);
      } catch (cause) { if (active) setOAuthError(getErrorMessage(cause)); }
    };
    void refresh();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [oauthAttemptId, selectedScope, selectedCatalogId]);
  async function create(catalogId: string, connectionId?: string) {
    const op = beginChannelOperation();
    if (!op) return;
    setEntryBusy(true);
    try {
      const created = await op.write(
        () =>
          createChannelSetupDraft({
            catalogId,
            connectionId,
            ...(connectionId ? { lifecycleMode: "edit" as const } : {}),
          }),
        (draft) => assertChannelDraft(draft, { catalogId, connectionId }),
      );
      if (!s.isCurrentDraft()) return;
      s.mergeDraft(created);
      s.setSelectedDraftId(created.draftId);
      s.setPanel("editor");
      s.setNotice({ tone: "success", message: "Channel setup draft created." });
    } catch (cause) {
      if (s.isCurrentDraft()) s.setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      op.finish();
      setEntryBusy(false);
    }
  }
  const handleCreate = async () => {
    if (!s.createDefinition) {
      s.setNotice({ tone: "warning", message: "Choose a channel definition first." });
      return;
    }
    await create(s.createDefinition.catalog.catalogId);
  };
  const editConnection = async () => {
    if (!s.selectedConnection || s.mutation.pending || s.mutation.uncertain) return;
    const existing = s.data?.drafts.find((draft) => draft.connectionId === s.selectedConnection!.connectionId);
    if (existing) {
      s.draftSelectionGuard.requestTransition(existing.draftId);
      return;
    }
    await create(s.selectedConnection.catalogId, s.selectedConnection.connectionId);
  };

  const savedSelection = async (): Promise<ChannelSetupDraft | undefined> => {
    const draft = s.selectedDraft;
    const epoch = s.inputEpoch.current;
    if (!draft || s.needsConnectionReview || s.channelDraft.hasRemoteChanges) {
      s.setNotice({ tone: "warning", message: "Open a saved channel draft and review any connection changes first." });
      return;
    }
    const saved = s.draftDirty ? await saveDraft?.() : draft;
    if (!saved) return;
    if (!s.isCurrentDraft() || s.inputEpoch.current !== epoch) return;
    const fresh = await fetchChannelSetupDraft(draft.draftId);
    if (!s.isCurrentDraft() || s.inputEpoch.current !== epoch) return;
    assertChannelDraft(fresh, saved);
    if (fresh.revision !== saved.revision) {
      s.mergeDraft(fresh);
      throw new Error("This draft changed elsewhere. Review its current revision before continuing setup.");
    }
    s.mergeDraft(fresh);
    return fresh;
  };
  const handleStartSlackOAuth = async () => {
    if (entryBusy || s.mutation.pending || s.mutation.uncertain) return;
    if (s.selectedDraft?.catalogId !== "channel.slack") {
      s.setNotice({ tone: "info", message: "Start a Slack guided setup draft first, then connect its workspace." }); return;
    }
    setEntryBusy(true);
    let op: ReturnType<typeof beginChannelOperation> = undefined;
    try {
      const draft = await savedSelection();
      if (!draft || !s.isCurrentDraft()) return;
      op = beginChannelOperation(); if (!op) return;
      const result = await op.write(() => startStagedSlackOAuth({
        workspaceId: s.activeWorkspaceId, draftId: draft.draftId, expectedRevision: draft.revision,
      }), (value) => {
        if (!value.configured) return;
        if (!value.attempt || !value.authorizationUrl || !value.state) throw new Error("The Gateway did not return a staged Slack attempt.");
        assertAttempt(value.attempt);
        const url = new URL(value.authorizationUrl);
        if (value.attempt.draftRevision !== draft.revision || url.protocol !== "https:" || url.username || url.password ||
          url.searchParams.get("state") !== value.state) throw new Error("The Slack authorization URL did not bind the reviewed draft.");
      }, draft.draftId);
      if (!s.isCurrentDraft()) return;
      if (!result.configured) {
        setOAuthError("Slack OAuth needs configuration: " + (result.missing.join(", ") || "missing OAuth settings")); return;
      }
      setOAuthAttempt(result.attempt!); setOAuthAttemptId(result.attempt!.attemptId);
      setAuthorizationUrl(result.authorizationUrl!); setOAuthError(null);
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      s.setNotice({ tone: "info", message: "Approve Slack, then review the exact workspace and app receipt here. Authorization does not activate a connection." });
    } catch (cause) { if (s.isCurrentDraft()) setOAuthError(getErrorMessage(cause)); }
    finally { op?.finish(); setEntryBusy(false); }
  };
  const handleAdoptSlackOAuth = async () => {
    const attempt = oauthAttempt, draft = s.selectedDraft;
    if (!attempt || !draft || entryBusy || s.draftDirty || attempt.status !== "ready" ||
      attempt.draftRevision !== draft.revision || s.needsConnectionReview) return;
    const op = beginChannelOperation(); if (!op) return;
    const input = s.channelDraft.value;
    setEntryBusy(true);
    try {
      const receipt = await op.write(() => adoptSlackOAuthInstall({ workspaceId: s.activeWorkspaceId,
        draftId: draft.draftId, expectedRevision: draft.revision, attemptId: attempt.attemptId }), (value) => {
        assertAttempt(value.attempt);
        assertChannelDraft(value.draft, draft, draft.revision);
        if (value.attempt.attemptId !== attempt.attemptId || value.attempt.status !== "adopted" ||
          value.attempt.adoptedDraftRevision !== value.draft.revision) throw new Error("Slack adoption did not acknowledge the exact draft and attempt.");
      }, draft.draftId);
      if (!s.isCurrentDraft()) return;
      s.mergeDraft(receipt.draft);
      s.channelDraft.acceptSaved({ label: receipt.draft.label ?? "", enabled: receipt.draft.enabled,
        values: receipt.draft.draft, advancedText: formatJson(receipt.draft.draft) }, receipt.draft.revision, input);
      setOAuthAttempt(receipt.attempt); setAuthorizationUrl(null); s.setValidationResult(null);
      s.setNotice({ tone: "success", message: "The reviewed Slack install is saved in this draft. Choose destinations, test, and review the activation plan." });
    } catch (cause) { if (s.isCurrentDraft()) setOAuthError(getErrorMessage(cause)); }
    finally { op.finish(); setEntryBusy(false); }
  };
  const handleCancelSlackOAuth = async () => {
    if (!oauthAttempt || entryBusy) return;
    const op = beginChannelOperation(); if (!op) return;
    setEntryBusy(true);
    try {
      const receipt = await op.write(() => cancelChannelOAuthAttempt({ workspaceId: s.activeWorkspaceId,
        attemptId: oauthAttempt.attemptId, expectedRevision: oauthAttempt.revision }), (value) => {
        assertAttempt(value); if (value.attemptId !== oauthAttempt.attemptId || value.status !== "cancelled")
          throw new Error("The OAuth cancellation receipt does not match this attempt.");
      }, s.selectedDraftId);
      if (s.isCurrentDraft()) { setOAuthAttempt(receipt); setAuthorizationUrl(null); }
    } catch (cause) { if (s.isCurrentDraft()) setOAuthError(getErrorMessage(cause)); }
    finally { op.finish(); setEntryBusy(false); }
  };
  const handleDiscoverTelegramTargets = async () => {
    if (s.selectedDraft?.catalogId !== "channel.telegram" || entryBusy || s.mutation.pending || s.mutation.uncertain) return;
    setEntryBusy(true);
    try {
      const draft = await savedSelection();
      if (!draft || !s.isCurrentDraft()) return;
      const epoch = s.inputEpoch.current;
      const result = await discoverTelegramSetupTargets({ source: "draft", draftId: draft.draftId,
        expectedRevision: draft.revision, setupCode: readDraftString(draft.draft, "setupCode") });
      if (!s.isCurrentDraft() || s.inputEpoch.current !== epoch) return;
      setDiscovery({ result, draftId: draft.draftId, revision: draft.revision, epoch });
      setSelectedCandidates({});
      s.setNotice({ tone: result.items.length ? "info" : "warning", message: result.items.length ?
        "Choose discovered chats to add. Existing destinations and your default remain." :
        "No recent chats were returned. Send /start or the setup code, then refresh discovery." });
    } catch (cause) { if (s.isCurrentDraft()) s.setNotice({ tone: "error", message: getErrorMessage(cause) }); }
    finally { setEntryBusy(false); }
  };
  const handleMergeTelegramTargets = () => {
    if (!discovery || discovery.draftId !== s.selectedDraftId || discovery.epoch !== s.inputEpoch.current ||
      discovery.revision !== s.selectedDraft?.revision) return;
    const rows = readChannelTargetRows(s.draftValues.targets, "chatId");
    const selected = discovery.result.items.filter((item) => selectedCandidates[item.id])
      .map((item) => ({ id: item.id, label: item.label, chatId: item.chatId, kind: item.kind }));
    s.setDraftValues({ ...s.draftValues, targets: mergeDiscoveredChannelTargets(rows, selected) });
    s.setValidationResult(null); setDiscovery(null); setSelectedCandidates({});
  };
  return { entryBusy, handleCreate, editConnection, handleStartSlackOAuth, oauthAttempt, oauthError, authorizationUrl,
    refreshOAuthAttempt, handleAdoptSlackOAuth, handleCancelSlackOAuth, handleDiscoverTelegramTargets,
    discovery: discovery?.draftId === s.selectedDraftId ? discovery.result : null, selectedCandidates, setSelectedCandidates,
    discoveryCurrent: Boolean(discovery && discovery.epoch === s.inputEpoch.current && discovery.revision === s.selectedDraft?.revision),
    handleMergeTelegramTargets };
}
