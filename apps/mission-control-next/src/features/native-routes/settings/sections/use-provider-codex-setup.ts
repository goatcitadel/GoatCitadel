import { fetchLlmConfig, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { buildChatGptOAuthProviderDraft } from "../helpers/provider-drafts";
import { getErrorMessage } from "../SettingsShared";
import { useSettingsChange } from "../use-settings-change";
import { matchesProviderSave, matchesProviderSavePlan, providerSaveInput } from "./provider-save-contract";
import {
  beginProviderMutation,
  finishProviderMutation,
  isProviderPrecommitConflict,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";
import type { ProviderCatalog, ProviderNoticeSetter } from "./provider-section-types";

export function useProviderCodexSetup({
  config,
  reload,
  loadModelsForProvider,
  setNotice,
  onSaved,
  viewIdentity,
}: Pick<ProviderCatalog, "config" | "reload" | "loadModelsForProvider"> & {
  setNotice: ProviderNoticeSetter;
  onSaved: () => void;
  viewIdentity: unknown;
}) {
  const mutation = useProviderMutationState();
  const capture = useProviderEditorEpoch(viewIdentity);
  const change = useSettingsChange({
    key: "provider-setup:system:openai-codex",
    read: fetchLlmConfig,
    matchesPlan: matchesProviderSavePlan,
    matches: matchesProviderSave,
    acceptSaved: () => true,
    reload,
  });
  const add = async () => {
    if (change.isPending()) {
      await change.refresh();
      return;
    }
    if (!config || !Number.isSafeInteger(config.revision) || config.revision < 1) {
      setNotice({ tone: "warning", message: "Reload provider settings before adding a provider." });
      return;
    }
    if (!change.beginSave()) return;
    if (!beginProviderMutation()) {
      change.endSave();
      return;
    }
    const isCurrent = capture(),
      revision = config.revision;
    let attempted = false,
      acknowledged = false;
    try {
      const latest = await fetchLlmConfig();
      if (!isCurrent()) return;
      if (latest.revision !== revision) {
        await reload();
        if (isCurrent())
          setNotice({
            tone: "warning",
            message: "Provider settings changed. Review the current settings before adding ChatGPT setup.",
          });
        return;
      }
      if (latest.providers.some((provider) => provider.providerId === "openai-codex")) {
        if (isCurrent()) onSaved();
        return;
      }
      const draft = { provider: buildChatGptOAuthProviderDraft(), transport: createEmptyLlmTransportDraft() };
      const { request: _transport, ...profile } = providerSaveInput(draft);
      attempted = true;
      const updated = await patchSettings({ expectedRevision: revision, llm: { upsertProvider: profile } });
      const next =
        updated.changePlanReceipt && !["completed", "applied"].includes(updated.changePlanReceipt.status)
          ? { ...updated.llm, revision: updated.revision, changePlanReceipt: updated.changePlanReceipt }
          : { ...(await fetchLlmConfig()), changePlanReceipt: updated.changePlanReceipt };
      const settled = change.receive(next, draft, revision);
      acknowledged = true;
      await reload();
      if (settled && isCurrent()) {
        onSaved();
        setNotice({ tone: "success", message: "ChatGPT provider added. Start ChatGPT login below." });
      }
      if (settled) void loadModelsForProvider("openai-codex", { force: true });
    } catch (error) {
      if (attempted && !acknowledged && isProviderPrecommitConflict(error, revision)) {
        await reload();
        if (isCurrent())
          setNotice({
            tone: "warning",
            message: "Provider settings changed elsewhere. Review the current settings, then add ChatGPT setup again.",
          });
        return;
      }
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (isCurrent())
        setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged setup, but refreshing provider evidence failed."
            : getErrorMessage(error),
        });
    } finally {
      change.endSave();
      finishProviderMutation();
    }
  };
  return { ...change, add, mutation };
}
