import { useRef, useState } from "react";
import {
  createChannelSetupDraft,
  discoverTelegramTargets,
  fetchSlackOAuthStatus,
  startSlackOAuth,
} from "@goatcitadel/mission-control-shared/api/client";
import { delay, readConnectionConfigString, readDraftString } from "../helpers/input-format";
import { getErrorMessage } from "../SettingsShared";
import { assertChannelDraft, beginChannelOperation } from "./channel-setup-state";
import type { ChannelSetupState } from "./use-channel-setup-state";

export function useChannelSetupEntry(s: ChannelSetupState) {
  const current = useRef({ catalogId: s.createCatalogId, value: s.channelDraft.value });
  current.current = { catalogId: s.createCatalogId, value: s.channelDraft.value };
  const [entryBusy, setEntryBusy] = useState(false);
  const poll = useRef(0);
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
  const handleStartSlackOAuth = async () => {
    const op = beginChannelOperation();
    if (!op) return;
    const generation = ++poll.current;
    setEntryBusy(true);
    try {
      const status = await fetchSlackOAuthStatus();
      if (!s.isCurrentDraft()) return;
      if (!status.configured) {
        s.setNotice({
          tone: "warning",
          message: `Slack OAuth needs configuration first: ${status.missing.join(", ") || "missing OAuth settings"}.`,
        });
        return;
      }
      const previous = new Map(
        status.connections.map((item) => [
          item.connection.connectionId,
          readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? "",
        ]),
      );
      const result = await op.write(startSlackOAuth, (value) => {
        const url = new URL(value.authorizationUrl);
        if (
          !value.configured ||
          !value.state ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.searchParams.get("state") !== value.state
        )
          throw new Error("The Gateway did not return a bound, secure Slack authorization URL.");
      });
      if (!s.isCurrentDraft()) return;
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      s.setNotice({
        tone: "info",
        message: "Slack authorization opened. Approve the workspace, then return to channels and explicitly select the intended workspace connection to continue setup.",
      });
      // OAuth status has no state-to-connection binding. Observations never select
      // or create a draft for a connection another client may have installed.
      void (async () => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await delay(2000);
          if (!s.isCurrentDraft() || generation !== poll.current) return;
          let next: Awaited<ReturnType<typeof fetchSlackOAuthStatus>>;
          try {
            next = await fetchSlackOAuthStatus();
          } catch {
            continue;
          }
          if (!s.isCurrentDraft() || generation !== poll.current) return;
          const installed = next.connections.find(
            (item) =>
              previous.get(item.connection.connectionId) !==
              (readConnectionConfigString(item.connection.config, "oauthConnectedAt") ?? ""),
          );
          if (installed) {
            await s.reload();
            if (s.isCurrentDraft())
              s.setNotice({
                tone: "info",
                message:
                  "Slack connection evidence changed. Return to channels and explicitly select the intended workspace connection to continue setup.",
              });
            return;
          }
        }
        if (s.isCurrentDraft())
          s.setNotice({
            tone: "warning",
            message:
              "Slack authorization may still be finishing. Refresh channel connections if the workspace was approved.",
          });
      })();
    } catch (cause) {
      if (s.isCurrentDraft()) s.setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      op.finish();
      setEntryBusy(false);
    }
  };
  const handleDiscoverTelegramTargets = async () => {
    if (!s.selectedDraft || entryBusy || s.mutation.pending || s.mutation.uncertain) return;
    const input = s.channelDraft.value;
    const generation = s.inputEpoch.current;
    setEntryBusy(true);
    try {
      const result = await discoverTelegramTargets({
        connectionId: s.selectedDraft.connectionId,
        botToken: readDraftString(input.values, "botToken"),
        botTokenEnv: readDraftString(input.values, "botTokenEnv") ?? readDraftString(input.values, "tokenEnv"),
        setupCode: readDraftString(input.values, "setupCode"),
      });
      if (!s.isCurrentDraft() || s.inputEpoch.current !== generation) return;
      if (!result.items.length) {
        s.setNotice({
          tone: "warning",
          message:
            "Telegram did not return recent chats yet. Send /start or the setup code in the target chat and try again.",
        });
        return;
      }
      const targets = result.items.map((item, index) => ({
        id: item.id,
        label: item.label,
        chatId: item.chatId,
        kind: item.kind,
        default: index === 0,
      }));
      s.setDraftValues({ ...input.values, targets, defaultChatId: targets[0]?.chatId });
      s.setValidationResult(null);
      s.setNotice({
        tone: "success",
        message: `Detected ${targets.length} Telegram target${targets.length === 1 ? "" : "s"}.`,
      });
    } catch (cause) {
      if (s.isCurrentDraft()) s.setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally {
      setEntryBusy(false);
    }
  };
  return { entryBusy, handleCreate, editConnection, handleStartSlackOAuth, handleDiscoverTelegramTargets };
}
