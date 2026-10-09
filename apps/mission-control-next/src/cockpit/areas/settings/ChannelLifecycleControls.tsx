import { useEffect, useRef, useState } from "react";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import {
  deleteIntegrationConnection,
  discardChannelSetupDraft,
  fetchChannelSetupDraft,
  fetchIntegrationConnection,
  isApiRequestError,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayCallerScope, subscribeGatewayAccessChange, subscribeGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { subscribeCockpitHistory } from "../../app/cockpit-history";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  beginChannelOperation,
  useChannelMutationState,
} from "../../../features/native-routes/settings/sections/channel-setup-state";
import {
  beginIntegrationMutation,
  commitIntegrationConnectionUpdate,
  integrationConnectionReviewMatches,
  integrationConflictIsUncommitted,
  useIntegrationConnectionMutation,
} from "../../../features/native-routes/settings/integration-connection-mutation";
import {
  verifyIntegrationDeleted,
  verifyIntegrationReadback,
} from "../../../features/native-routes/settings/sections/integration-editor-receipts";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Selection =
  | { draft: ChannelSetupDraft; connection?: never }
  | { connection: IntegrationConnection; draft?: never };
export function ChannelLifecycleControls({
  workspaceId,
  selection,
  reload,
}: {
  workspaceId: string;
  selection: Selection;
  reload: () => Promise<unknown>;
}) {
  const { draft, connection } = selection;
  const id = draft?.draftId ?? connection!.connectionId;
  const channel = useChannelMutationState();
  const mutation = useIntegrationConnectionMutation(id);
  const [review, setReview] = useState<{ action: "toggle" | "delete"; identity: string; epoch: number } | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    const invalidate = () => { epoch.current += 1; setReview(null); };
    const subscriptions = [subscribeGatewayAccessChange(invalidate), subscribeGatewayCallerScope(invalidate), subscribeCockpitHistory(invalidate)];
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, []);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const identity = JSON.stringify([
    getGatewayApiBaseUrl(),
    getGatewayCallerScope(),
    workspaceId,
    id,
    draft?.revision ?? connection?.revision,
    window.location.href,
  ]);
  const latest = useRef(identity);
  if (latest.current !== identity) epoch.current += 1;
  latest.current = identity;
  const locked = channel.pending || Boolean(channel.uncertain) || mutation.locked;
  const current = () =>
    mounted.current &&
    review?.epoch === epoch.current &&
    review?.identity === latest.current &&
    identity ===
      JSON.stringify([
        getGatewayApiBaseUrl(),
        getGatewayCallerScope(),
        workspaceId,
        id,
        draft?.revision ?? connection?.revision,
        window.location.href,
      ]);
  async function confirm() {
    if (locked || busy.current || !review || !current()) return;
    busy.current = true;
    try {
      if (draft) {
        const fresh = await fetchChannelSetupDraft(id);
        if (!current()) return;
        if (fresh.draftId !== id || fresh.catalogId !== draft.catalogId || fresh.revision !== draft.revision)
          throw new Error("The draft changed. Refresh and review its current version.");
        const op = beginChannelOperation();
        if (!op) return;
        try {
          await op.write(
            () => discardChannelSetupDraft(id, draft.revision),
            async (receipt) => {
              if (!receipt.deleted || receipt.draftId !== id) throw new Error("Deletion was not acknowledged.");
              try {
                await fetchChannelSetupDraft(id);
                throw new Error("The draft is still present; refresh before any further action.");
              } catch (cause) {
                if (
                  !isApiRequestError(cause) ||
                  cause.status !== 404 ||
                  cause.method !== "GET" ||
                  cause.path !== `/api/v1/channels/drafts/${encodeURIComponent(id)}` ||
                  (cause.body as { code?: string } | undefined)?.code !== "ENTITY_NOT_FOUND"
                )
                  throw cause;
              }
            },
            id,
          );
        } finally {
          op.finish();
        }
      } else if (connection) {
        const fresh = await fetchIntegrationConnection(id);
        if (!current()) return;
        if (!integrationConnectionReviewMatches(connection, fresh))
          throw new Error("The connection changed. Refresh and review its current version.");
        if (review.action === "toggle") {
          const result = await commitIntegrationConnectionUpdate({
            reviewed: connection,
            input: { expectedRevision: connection.revision, enabled: !connection.enabled },
            isCurrent: current,
            verify: verifyIntegrationReadback,
          });
          if (result.status !== "saved") throw new Error(result.message);
        } else {
          const op = beginIntegrationMutation(id);
          if (!op) return;
          try {
            await op.write(
              () => deleteIntegrationConnection(id, connection.revision),
              (receipt) => verifyIntegrationDeleted(id, receipt),
              (cause) => integrationConflictIsUncommitted(cause, id, "DELETE"),
            );
          } finally {
            op.finish();
          }
        }
      }
      if (current()) {
        setNotice(
          review.action === "delete"
            ? "Deletion confirmed by the Gateway owner."
            : "Saved channel state confirmed. Connectivity has not been tested.",
        );
        setReview(null);
        await reload();
      }
    } catch {
      if (current()) {
        setNotice("The reviewed change could not be confirmed. Refresh to inspect the saved record. Any uncertain-action lock remains in force.");
        setReview(null);
      }
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {connection ? (
          <Button disabled={locked} onClick={() => setReview({ action: "toggle", identity, epoch: epoch.current })}>
            Review {connection.enabled ? "disable" : "enable"} channel
          </Button>
        ) : null}
        <Button variant="danger" disabled={locked} onClick={() => setReview({ action: "delete", identity, epoch: epoch.current })}>
          {draft ? "Delete saved draft" : "Remove channel connection"}
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {channel.uncertain || mutation.message ? (
        <p role="status" className="text-sm">
          {channel.uncertain ?? mutation.message}
        </p>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open && !locked) setReview(null);
        }}
        title="Review channel lifecycle change"
        description={
          draft
            ? "Delete this exact saved draft and its temporary credentials. Existing finalized connections remain governed by their own owner."
            : "This affects the saved installation-wide connection and may stop its runtime. External messages and previously completed actions cannot be undone here."
        }
      >
        <p className="break-words text-sm">
          {draft?.label ?? connection?.label} · reviewed version {draft?.revision ?? connection?.revision}
        </p>
        {!current() ? <p role="alert">The reviewed scope or record changed. Close and review again.</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="danger" disabled={locked || !current()} onClick={() => void confirm()}>
            Apply reviewed channel change
          </Button>
          <Button disabled={locked} onClick={() => setReview(null)}>
            Keep current channel state
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
