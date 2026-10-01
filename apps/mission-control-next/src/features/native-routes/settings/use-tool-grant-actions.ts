import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import {
  createToolGrant,
  fetchToolGrants,
  isApiRequestError,
  revokeToolGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  normalizeToolGrantDraft,
  sameToolGrantIdentity,
  toolGrantMatchesRequest,
  type ToolGrantDraft,
  type ToolGrantRequest,
} from "./tool-grant-binding";

type Attempt = { phase: "checking" | "saving" | "uncertain" | "confirmed"; message: string };
type Review = { key: string; resolve: (saved: boolean) => void } & (
  | { kind: "create"; draft: ToolGrantDraft; input: ToolGrantRequest }
  | { kind: "revoke"; grant: ToolGrantRecord }
);
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => version;
function publish(key: string, attempt?: Attempt) {
  if (attempt) attempts.set(key, attempt);
  else attempts.delete(key);
  version += 1;
  for (const listener of listeners) listener();
}
function failedBeforeCommit(error: unknown) {
  if (!isApiRequestError(error) || ![400, 401, 403, 404, 429].includes(error.status ?? 0)) return false;
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
  const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
  return (
    body.committed !== true &&
    body.mutationCommitted !== true &&
    details.committed !== true &&
    details.mutationCommitted !== true
  );
}

/** Shared classic/cockpit mutation lifecycle. Locks are presentation state for this app session. */
export function useToolGrantActions(ownerKey: string, reload: () => Promise<unknown>) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const owner = useRef<string | null>(ownerKey),
    sequence = useRef(0),
    reviewRef = useRef<Review | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "error"; message: string } | null>(null);
  useEffect(() => {
    owner.current = ownerKey;
    sequence.current += 1;
    setReview(null);
    setNotice(null);
    return () => {
      owner.current = null;
      sequence.current += 1;
      reviewRef.current?.resolve(false);
      reviewRef.current = null;
    };
  }, [ownerKey]);
  const attemptFor = (key: string) => attempts.get(key);
  const pending = Boolean(review && ["checking", "saving"].includes(attempts.get(review.key)?.phase ?? ""));
  function requestCreate(draft: ToolGrantDraft): Promise<boolean> {
    if (attempts.has("create") || reviewRef.current) return Promise.resolve(false);
    let input: ToolGrantRequest;
    try {
      input = normalizeToolGrantDraft(draft);
    } catch (error) {
      setNotice({ tone: "warning", message: describeApiError(error).summary });
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const next: Review = { kind: "create", key: "create", draft: { ...draft }, input, resolve };
      sequence.current += 1;
      reviewRef.current = next;
      setReview(next);
      setNotice(null);
    });
  }
  function requestRevoke(grant: ToolGrantRecord) {
    const key = `revoke:${grant.grantId}`;
    if (!grant.grantId || grant.revokedAt || attempts.has(key) || reviewRef.current) return;
    const next: Review = { kind: "revoke", key, grant: structuredClone(grant), resolve: () => undefined };
    sequence.current += 1;
    reviewRef.current = next;
    setReview(next);
    setNotice(null);
  }
  function cancel() {
    const selected = reviewRef.current;
    if (selected && attempts.get(selected.key)?.phase === "saving") return;
    sequence.current += 1;
    selected?.resolve(false);
    reviewRef.current = null;
    setReview(null);
  }
  async function confirm(): Promise<boolean> {
    const selected = reviewRef.current;
    if (!selected || attempts.has(selected.key)) return false;
    const token = sequence.current;
    const current = () => owner.current === ownerKey && sequence.current === token && reviewRef.current === selected;
    publish(selected.key, { phase: "checking", message: "Checking current grant records…" });
    let dispatched = false,
      recorded = false;
    try {
      const before = await fetchToolGrants({ limit: 400 });
      if (!current()) return false;
      if (selected.kind === "revoke") {
        const matches = before.items.filter((item) => item.grantId === selected.grant.grantId);
        if (matches.length !== 1 || !sameToolGrantIdentity(selected.grant, matches[0]) || matches[0]!.revokedAt) {
          throw new Error("The reviewed grant changed or is already revoked. Refresh before reviewing it again.");
        }
      } else normalizeToolGrantDraft(selected.draft);
      dispatched = true;
      publish(selected.key, {
        phase: "saving",
        message:
          selected.kind === "create" ? "Recording the reviewed tool grant…" : "Revoking the reviewed tool grant…",
      });
      if (selected.kind === "create") {
        const receipt = await createToolGrant(selected.input);
        if (
          !toolGrantMatchesRequest(receipt, selected.input) ||
          receipt.revokedAt ||
          (selected.input.grantType === "one_time" && receipt.usesRemaining !== 1)
        )
          throw new Error("The Gateway did not confirm the exact reviewed grant.");
        recorded = true;
        const saved = (await fetchToolGrants({ limit: 400 })).items.filter((item) => item.grantId === receipt.grantId);
        if (saved.length !== 1 || !sameToolGrantIdentity(receipt, saved[0]))
          throw new Error("The recorded grant could not be confirmed in its owner.");
        publish(selected.key);
      } else {
        const receipt = await revokeToolGrant(selected.grant.grantId);
        if (receipt.revoked !== true || receipt.grantId !== selected.grant.grantId || !receipt.revokedBy)
          throw new Error("The Gateway did not confirm the reviewed revocation.");
        recorded = true;
        const saved = (await fetchToolGrants({ limit: 400 })).items.filter(
          (item) => item.grantId === selected.grant.grantId,
        );
        if (
          saved.length !== 1 ||
          !sameToolGrantIdentity(selected.grant, saved[0]) ||
          !Number.isFinite(Date.parse(saved[0]!.revokedAt ?? "")) ||
          saved[0]!.revokedBy !== receipt.revokedBy
        )
          throw new Error("The current owner did not confirm the revocation.");
        publish(selected.key, { phase: "confirmed", message: "Tool grant revoked." });
      }
      if (current()) {
        selected.resolve(true);
        reviewRef.current = null;
        setReview(null);
        setNotice({
          tone: "success",
          message:
            selected.kind === "create"
              ? "Tool grant recorded. Effective policy and approval gates still apply."
              : "Tool grant revoked.",
        });
        try {
          await reload();
        } catch {
          if (owner.current !== ownerKey || sequence.current !== token) return true;
          setNotice({
            tone: "warning",
            message: "The write was confirmed, but the displayed list could not refresh. Refresh the grant records.",
          });
        }
      }
      return true;
    } catch (error) {
      const unknown = dispatched && (recorded || !failedBeforeCommit(error));
      const message = unknown
        ? `${recorded ? "A receipt was recorded, but current grant state is unconfirmed." : "Grant write outcome is unconfirmed."} Further attempts are locked in this app session. Inspect current grant records before taking another action.`
        : describeApiError(error).summary;
      if (unknown) publish(selected.key, { phase: "uncertain", message });
      else publish(selected.key);
      if (current()) {
        selected.resolve(false);
        reviewRef.current = null;
        setReview(null);
        setNotice({ tone: unknown ? "warning" : "error", message });
      }
      return false;
    } finally {
      if (!dispatched) publish(selected.key);
    }
  }
  return { review, notice, pending, requestCreate, requestRevoke, cancel, confirm, attemptFor };
}

export function __resetToolGrantActionsForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
