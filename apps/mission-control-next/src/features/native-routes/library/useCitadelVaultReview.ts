import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { getCitadelVaultSnapshot } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { sameVaultValue } from "./citadel-vault-binding";
import {
  vaultMutationMatches,
  hasVaultSnapshot,
  isVaultPrewriteRejection,
  type VaultChange,
} from "./citadel-vault-binding";
import { vaultAttempt, vaultLocked, setVaultAttempt, subscribeVaultAttempts } from "./citadel-vault-state";

interface VaultState {
  key: string;
  snapshot: CitadelVaultSnapshot | null;
  loading: boolean;
  error: string | null;
  reviewRequired: boolean;
}
/** Installation-bound Vault admission, exact preflight and independent readback. */
export function useCitadelVaultReview(citadelId: string) {
  const installation = getGatewayApiBaseUrl(),
    key = JSON.stringify([installation, citadelId]);
  const attempt = useSyncExternalStore(
    subscribeVaultAttempts,
    () => vaultAttempt(key),
    () => vaultAttempt(key),
  );
  const live = useRef({ key, binding: {}, mounted: true, epoch: 0, read: 0 });
  if (live.current.key !== key) {
    live.current.key = key;
    live.current.binding = {};
    live.current.epoch += 1;
    live.current.read += 1;
  }
  const binding = live.current.binding;
  const [stored, setState] = useState<VaultState>({
    key,
    snapshot: null,
    loading: true,
    error: null,
    reviewRequired: false,
  });
  const state: VaultState =
    stored.key === key ? stored : { key, snapshot: null, loading: true, error: null, reviewRequired: false };
  const isCurrent = useCallback(
    () =>
      live.current.mounted &&
      live.current.binding === binding &&
      live.current.key === key &&
      getGatewayApiBaseUrl() === installation,
    [binding, installation, key],
  );
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch += 1;
      owner.read += 1;
    };
  }, [key]);
  const read = useCallback(async () => {
    const snapshot = await getCitadelVaultSnapshot(citadelId);
    if (getGatewayApiBaseUrl() !== installation || !hasVaultSnapshot(snapshot, citadelId))
      throw new Error("The Vault owner returned a different or unavailable Citadel.");
    return snapshot;
  }, [citadelId, installation]);
  const reload = useCallback(async () => {
    const readId = ++live.current.read,
      current = () => isCurrent() && live.current.read === readId;
    setState((previous) => ({
      ...previous,
      key,
      snapshot: previous.key === key ? previous.snapshot : null,
      reviewRequired: previous.key === key && previous.reviewRequired,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await read();
      if (current())
        setState((previous) => ({
          key,
          snapshot,
          loading: false,
          error: null,
          reviewRequired: previous.key === key && previous.reviewRequired,
        }));
    } catch (error) {
      if (current())
        setState((previous) => ({
          ...previous,
          key,
          snapshot: null,
          loading: false,
          error: describeVaultError(error),
        }));
    }
  }, [isCurrent, key, read]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const busy = attempt.phase === "checking" || attempt.phase === "saving",
    locked = attempt.phase !== "idle";
  const snapshot = state.snapshot;
  const ready =
    Boolean(snapshot) &&
    !state.loading &&
    !state.error &&
    !state.reviewRequired &&
    !locked &&
    snapshot?.record?.lifecycleStatus !== "archived";
  const run = useCallback(
    async (
      expectedRevision: string | undefined,
      write: () => Promise<CitadelVaultSnapshot>,
      options: {
        change?: VaultChange;
        isReviewCurrent?: () => boolean;
        onConfirmed?: (saved: CitadelVaultSnapshot) => void;
        preflight?: () => Promise<boolean>;
      } = {},
    ) => {
      if (
        !options.change ||
        !isCurrent() ||
        !ready ||
        !snapshot ||
        expectedRevision !== snapshot.revision ||
        vaultLocked(key)
      )
        return null;
      const before = structuredClone(snapshot),
        epoch = live.current.epoch,
        readId = live.current.read;
      const current = () => isCurrent() && live.current.epoch === epoch && live.current.read === readId;
      const reviewCurrent = () => current() && (options.isReviewCurrent?.() ?? true);
      const change = options.change ? structuredClone(options.change) : undefined;
      let dispatched = false;
      setVaultAttempt(key, { phase: "checking", message: "Checking the reviewed Citadel Vault owner…" });
      try {
        if (options.preflight && !(await options.preflight())) return null;
        if (!reviewCurrent()) return null;
        const fresh = await read();
        if (!reviewCurrent()) return null;
        if (!sameVaultValue(fresh, before)) {
          setState({
            key,
            snapshot: fresh,
            loading: false,
            error:
              "Vault metadata changed. Review the current names and update times, then explicitly retry your change.",
            reviewRequired: true,
          });
          return null;
        }
        setVaultAttempt(key, { phase: "saving", message: "Waiting for the Gateway Vault owner…" });
        dispatched = true;
        const saved = await write();
        if (
          getGatewayApiBaseUrl() !== installation ||
          !hasVaultSnapshot(saved, citadelId) ||
          saved.revision === before.revision ||
          (change && !vaultMutationMatches(before, saved, change))
        )
          throw new Error("The Vault owner did not acknowledge the reviewed change.");
        const confirmed = await read();
        if (!sameVaultValue(saved, confirmed))
          throw new Error("The saved Vault metadata could not be independently confirmed.");
        setVaultAttempt(key, { phase: "idle" });
        options.onConfirmed?.(saved);
        if (!current()) return null;
        setState({ key, snapshot: saved, loading: false, error: null, reviewRequired: false });
        return saved;
      } catch (error) {
        if (!dispatched || (change && isVaultPrewriteRejection(error, citadelId, change))) {
          setVaultAttempt(key, { phase: "idle" });
          if (current()) {
            const conflict = dispatched && isApiRequestError(error) && error.status === 409;
            setState((previous) => ({ ...previous, error: describeVaultError(error), reviewRequired: conflict }));
            if (conflict) await reload();
          }
        } else
          setVaultAttempt(key, {
            phase: "uncertain",
            message:
              "Vault outcome is unconfirmed. Inspect the current metadata before any further Vault change; retry is withheld in this app session.",
          });
        return null;
      } finally {
        if (!dispatched) setVaultAttempt(key, { phase: "idle" });
      }
    },
    [citadelId, installation, isCurrent, key, read, ready, reload, snapshot],
  );
  return {
    snapshot,
    loading: state.loading,
    error: attempt.phase === "uncertain" ? (attempt.message ?? null) : state.error,
    reviewRequired: state.reviewRequired,
    busy,
    locked,
    ready,
    run,
    isCurrent,
    reload,
    key,
    attempt,
    acceptReview: () => {
      if (snapshot && !state.loading && !locked)
        setState((previous) => ({ ...previous, reviewRequired: false, error: null }));
    },
  };
}

/** Never surface upstream error text that could contain submitted credential bytes. */
export function describeVaultError(error: unknown): string {
  return isApiRequestError(error) && error.status === 503
    ? "Vault unavailable — your OS keychain could not provide a key. Secrets are never written in plaintext."
    : "The Vault request could not be confirmed. Refresh its metadata to inspect the current state.";
}
