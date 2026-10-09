import { useLayoutEffect, useRef, useState } from "react";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  commitIntegrationConnectionUpdate,
  hasIntegrationConnectionBinding,
  integrationConnectionReviewMatches,
  useIntegrationConnectionMutation,
} from "./integration-connection-mutation";

export const canToggleIntegration = (record: IntegrationConnection) =>
  hasIntegrationConnectionBinding(record) &&
  ["model_provider", "productivity", "automation", "platform"].includes(record.kind);

const LIST_REFRESHING_NOTICE = "The connection list is refreshing. Nothing was changed; try again when it finishes.";

export function useIntegrationEnabled({
  workspaceId,
  available,
  reload,
}: {
  workspaceId: string;
  available: boolean;
  reload: () => Promise<unknown>;
}) {
  const [review, setReview] = useState<{ connection: IntegrationConnection; enabled: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNoticeState] = useState<string | null>(null);
  // A lock message mirrors the locked connection's shared attempt (even after its review closes); once an outcome
  // check settles that attempt, the copy goes with it.
  const [noticeLockId, setNoticeLockId] = useState<string | null>(null);
  const setNotice = (text: string | null, lockedConnectionId: string | null = null) => {
    setNoticeState(text);
    setNoticeLockId(lockedConnectionId);
  };
  const attempt = useIntegrationConnectionMutation(review?.connection.connectionId ?? "");
  const lockAttempt = useIntegrationConnectionMutation(noticeLockId ?? "");
  const live = useRef({ workspaceId, available, epoch: 0, mounted: true, busy: false });
  if (live.current.workspaceId !== workspaceId) {
    live.current.workspaceId = workspaceId;
    live.current.epoch += 1;
  }
  live.current.available = available;
  useLayoutEffect(() => {
    const lifecycle = live.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
    };
  }, []);
  useLayoutEffect(() => {
    setReview(null);
    setNotice(null);
  }, [workspaceId]);
  const scopeCurrent = (epoch: number) => live.current.mounted && live.current.epoch === epoch;
  async function requestReview(connection: IntegrationConnection) {
    if (!available || live.current.busy || !canToggleIntegration(connection)) return;
    const epoch = ++live.current.epoch;
    live.current.busy = true;
    setChecking(true);
    setReview(null);
    setNotice(null);
    try {
      const current = await fetchIntegrationConnection(connection.connectionId);
      if (!scopeCurrent(epoch)) return;
      // The directory began refreshing during the read: that is not a changed connection, and its refetch is already
      // running, so say so instead of reloading again.
      if (!live.current.available) {
        setNotice(LIST_REFRESHING_NOTICE);
        return;
      }
      if (!canToggleIntegration(current) || !integrationConnectionReviewMatches(connection, current)) {
        setNotice("The connection changed. Refresh and review its current saved state.");
        await reload();
        return;
      }
      setReview({ connection: structuredClone(current), enabled: !current.enabled });
    } catch (error) {
      if (scopeCurrent(epoch)) setNotice(`Connection review unavailable: ${describeApiError(error).summary}`);
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  function cancel() {
    if (attempt.pending) return;
    live.current.epoch += 1;
    setReview(null);
  }
  async function confirm() {
    if (!review || !available || live.current.busy || attempt.locked) return;
    const requested = review;
    const epoch = live.current.epoch;
    const isCurrent = () => scopeCurrent(epoch) && live.current.available;
    live.current.busy = true;
    setChecking(true);
    setNotice(null);
    try {
      const current = await fetchIntegrationConnection(requested.connection.connectionId);
      if (!scopeCurrent(epoch)) return;
      // A directory refresh started during confirmation: nothing was sent. Keep the review so the operator can
      // confirm again once the list settles, and say why the click did nothing.
      if (!live.current.available) {
        setNotice(LIST_REFRESHING_NOTICE);
        return;
      }
      if (!canToggleIntegration(current) || !integrationConnectionReviewMatches(requested.connection, current)) {
        setReview(null);
        setNotice("The connection changed after review. Refresh and review it again.");
        await reload();
        return;
      }
      const result = await commitIntegrationConnectionUpdate({
        reviewed: requested.connection,
        input: { expectedRevision: requested.connection.revision, enabled: requested.enabled },
        isCurrent,
      });
      if (!scopeCurrent(epoch)) return;
      if (result.status === "saved") {
        setNotice(
          `Connection ${result.connection.label} ${result.connection.enabled ? "enabled" : "disabled"}. Saved state is confirmed; external connectivity has not been tested.`,
        );
        setReview(null);
      } else {
        setNotice(
          result.message,
          result.status === "uncertain" || result.status === "locked" ? requested.connection.connectionId : null,
        );
        if (result.status === "conflict") setReview(null);
      }
      try {
        await reload();
      } catch {
        /* Preserve the saved mutation acknowledgement; the directory owns its read error. */
      }
    } catch (error) {
      if (scopeCurrent(epoch)) setNotice(`Connection review unavailable: ${describeApiError(error).summary}`);
    } finally {
      live.current.busy = false;
      if (live.current.mounted) setChecking(false);
    }
  }
  return {
    review,
    checking,
    notice: noticeLockId && lockAttempt.phase !== "uncertain" ? null : notice,
    attempt,
    requestReview,
    cancel,
    confirm,
  };
}
