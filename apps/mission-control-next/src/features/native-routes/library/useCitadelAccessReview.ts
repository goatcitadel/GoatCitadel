import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { getCitadelAccessSnapshot } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getErrorMessage } from "../shared/native-helpers";
import { sameBlueprintValue } from "./citadel-blueprint-binding";
import {
  accessMutationMatches,
  hasCitadelAccessSnapshot,
  isAccessPrewriteConflict,
  type AccessEditorChange,
} from "./citadel-access-binding";
import { accessAttempt, accessLocked, setAccessAttempt, subscribeAccessAttempts } from "./citadel-access-state";

interface AccessState {
  key: string;
  snapshot: CitadelAccessSnapshot | null;
  loading: boolean;
  error: string | null;
  reviewRequired: boolean;
}
/** Installation-bound access admission, exact preflight and independent readback. */
export function useCitadelAccessReview(citadelId: string) {
  const installation = getGatewayApiBaseUrl(),
    key = JSON.stringify([installation, citadelId]);
  const attempt = useSyncExternalStore(
    subscribeAccessAttempts,
    () => accessAttempt(key),
    () => accessAttempt(key),
  );
  const live = useRef({ key, binding: {}, mounted: true, epoch: 0, read: 0 });
  if (live.current.key !== key) {
    live.current.key = key;
    live.current.binding = {};
    live.current.epoch += 1;
    live.current.read += 1;
  }
  const binding = live.current.binding;
  const [stored, setState] = useState<AccessState>({
    key,
    snapshot: null,
    loading: true,
    error: null,
    reviewRequired: false,
  });
  const state: AccessState =
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
    const snapshot = await getCitadelAccessSnapshot(citadelId);
    if (getGatewayApiBaseUrl() !== installation || !hasCitadelAccessSnapshot(snapshot, citadelId))
      throw new Error("The access owner returned a different or unavailable Citadel.");
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
        setState((previous) => ({ ...previous, key, snapshot: null, loading: false, error: getErrorMessage(error) }));
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
    snapshot?.structure.record?.lifecycleStatus !== "archived";
  const run = useCallback(
    async (
      expectedRevision: string | undefined,
      write: () => Promise<CitadelAccessSnapshot>,
      options: {
        change?: AccessEditorChange;
        isReviewCurrent?: () => boolean;
        onConfirmed?: (saved: CitadelAccessSnapshot) => void;
        preflight?: () => Promise<boolean>;
      } = {},
    ) => {
      if (!isCurrent() || !ready || !snapshot || expectedRevision !== snapshot.revision || accessLocked(key))
        return null;
      const before = structuredClone(snapshot),
        epoch = live.current.epoch,
        readId = live.current.read;
      const current = () => isCurrent() && live.current.epoch === epoch && live.current.read === readId;
      const reviewCurrent = () => current() && (options.isReviewCurrent?.() ?? true);
      const change = options.change ? structuredClone(options.change) : undefined;
      let dispatched = false;
      setAccessAttempt(key, { phase: "checking", message: "Checking the reviewed Citadel access owner…" });
      try {
        if (options.preflight && !(await options.preflight())) return null;
        if (!reviewCurrent()) return null;
        const fresh = await read();
        if (!reviewCurrent()) return null;
        if (!sameBlueprintValue(fresh, before)) {
          setState({
            key,
            snapshot: fresh,
            loading: false,
            error: "Access rules changed. Review the current rules, then explicitly retry your change.",
            reviewRequired: true,
          });
          return null;
        }
        setAccessAttempt(key, { phase: "saving", message: "Waiting for the Gateway access owner…" });
        dispatched = true;
        const saved = await write();
        if (
          getGatewayApiBaseUrl() !== installation ||
          !hasCitadelAccessSnapshot(saved, citadelId) ||
          saved.revision === before.revision ||
          (change && !accessMutationMatches(before, saved, change))
        )
          throw new Error("The access owner did not acknowledge the reviewed change.");
        const confirmed = await read();
        if (!sameBlueprintValue(saved, confirmed))
          throw new Error("The saved access rules could not be independently confirmed.");
        setAccessAttempt(key, { phase: "idle" });
        options.onConfirmed?.(saved);
        if (!current()) return null;
        setState({ key, snapshot: saved, loading: false, error: null, reviewRequired: false });
        return saved;
      } catch (error) {
        if (!dispatched || isAccessPrewriteConflict(error)) {
          setAccessAttempt(key, { phase: "idle" });
          if (current()) {
            setState((previous) => ({ ...previous, error: getErrorMessage(error), reviewRequired: dispatched }));
            if (dispatched) await reload();
          }
        } else
          setAccessAttempt(key, {
            phase: "uncertain",
            message:
              "Citadel access outcome is unconfirmed. Inspect the current rules before any further access change; retry is withheld in this app session.",
          });
        return null;
      } finally {
        if (!dispatched) setAccessAttempt(key, { phase: "idle" });
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
