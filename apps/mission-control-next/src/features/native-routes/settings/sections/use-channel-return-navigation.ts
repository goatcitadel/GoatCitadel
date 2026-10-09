import { useEffect, useRef } from "react";
import { createChannelPlanReviewHandoff, validNavigationId } from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { fetchChangePlan, fetchChannelSetupDraft, fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import type { ChannelSettingsOwner } from "./use-channel-settings";
/** A return URL selects only the fresh plan's canonical records; retained edits still use the leave guard. */
export function useChannelReturnNavigation(owner: ChannelSettingsOwner, search: string) {
  const applied = useRef<string | null>(null);
  const latestOwner = useRef(owner);
  latestOwner.current = owner;
  useEffect(() => {
    // This render's owner, read through the synced ref so the effect stays keyed on the link and scope fields.
    const owner = latestOwner.current;
    const returnKey = owner.activeWorkspaceId + ":" + search;
    if (!owner.data || applied.current === returnKey) return;
    const params = new URLSearchParams(search);
    if (!params.has("channelPlan")) return;
    const workspaceId = params.get("channelWorkspace"), planId = params.get("channelPlan"), draftId = params.get("channelDraft"), connectionId = params.get("channelConnection");
    if (["channelWorkspace", "channelPlan", "channelDraft"].some((key) => params.getAll(key).length !== 1) ||
      !validNavigationId(workspaceId) || !validNavigationId(planId) || !validNavigationId(draftId) ||
      params.getAll("channelConnection").length > 1 || connectionId !== null && !validNavigationId(connectionId)) {
      applied.current = returnKey;
      owner.setNotice({ tone: "warning", message: "The channel setup return link is incomplete. Open the current plan in Chat to return to its channels." }); return;
    }
    if (workspaceId !== owner.activeWorkspaceId) {
      applied.current = returnKey;
      owner.setNotice({ tone: "info", message: "This channel setup belongs to workspace " + workspaceId + ". Select that workspace to review its channels; your current edits are retained." }); return;
    }
    let active = true;
    void (async () => {
      try {
        const plan = await fetchChangePlan(planId, { workspaceId });
        if (plan.request.kind !== "channel_connection") throw new Error("The return link is not a channel setup plan.");
        const handoff = createChannelPlanReviewHandoff(plan);
        if (handoff.workspaceId !== workspaceId || handoff.planId !== planId || handoff.draftId !== draftId)
          throw new Error("The return link does not match this plan's workspace and draft.");
        const evidenceConnection = plan.evidenceRefs.find((ref) => ref.startsWith("channel-connection:"))?.slice("channel-connection:".length);
        if (connectionId && evidenceConnection !== connectionId) throw new Error("The returned connection is not recorded in the current plan's activation evidence.");
        if (evidenceConnection) {
          if (!validNavigationId(evidenceConnection)) throw new Error("The activation receipt has an invalid connection identity.");
          const connection = await fetchIntegrationConnection(evidenceConnection);
          if (connection.connectionId !== evidenceConnection || connection.catalogId !== plan.request.channelKind)
            throw new Error("The returned connection does not match the current plan's canonical activation receipt.");
          if (!active || !owner.isCurrentDraft()) return;
          applied.current = returnKey;
          owner.updateData((data) => ({ ...data, connections: [...data.connections.filter((item) => item.connectionId !== connection.connectionId), connection] }));
          owner.leave.request(() => {
            owner.setSelectedConnectionId(connection.connectionId); owner.setPanel("connection");
            void owner.reload();
          });
          return;
        }
        if (plan.status === "cancelled") {
          if (!active || !owner.isCurrentDraft()) return;
          applied.current = returnKey;
          owner.leave.request(() => {
            owner.setPanel(null);
            owner.setNotice({ tone: "info", message: "The channel setup plan was cancelled. No activation receipt was recorded. The current channels list is being refreshed." });
            void owner.reload();
          });
          return;
        }
        const draft = await fetchChannelSetupDraft(draftId);
        if (draft.draftId !== draftId || draft.catalogId !== plan.request.channelKind) throw new Error("The returned draft does not match the current plan.");
        if (!active || !owner.isCurrentDraft()) return;
        applied.current = returnKey;
        owner.mergeDraft(draft);
        owner.leave.request(() => { owner.setSelectedDraftId(draft.draftId); owner.setPanel("editor"); });
      } catch (cause) {
        if (active && owner.isCurrentDraft()) {
          applied.current = returnKey;
          owner.setNotice({ tone: "warning", message: cause instanceof Error ? cause.message : "The returned channel setup could not be verified. Refresh and open the current plan in Chat." });
        }
      }
    })();
    return () => { active = false; };
  }, [search, owner.activeWorkspaceId, owner.data, owner.createCatalogId]);
}
