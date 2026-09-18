import { useCallback, useEffect, useRef, useState } from "react";
import type { CitadelVaultSnapshot } from "@goatcitadel/contracts";
import { getCitadelVaultSnapshot, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../shared/native-helpers";

export function describeVaultError(error: unknown): string {
  return isApiRequestError(error) && error.status === 503
    ? "Vault unavailable — your OS keychain could not provide a key. Secrets are never written in plaintext."
    : getErrorMessage(error);
}

/** Metadata-only review. No credential bytes enter this hook's state. */
export function useCitadelVaultReview(citadelId: string) {
  const scope = useRef({ citadelId });
  if (scope.current.citadelId !== citadelId) scope.current = { citadelId };
  const token = scope.current;
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const reloadRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ token: object; snapshot: CitadelVaultSnapshot | null; loading: boolean; error: string | null; reviewRequired: boolean }>({ token, snapshot: null, loading: true, error: null, reviewRequired: false });
  const isCurrent = useCallback(() => mounted.current && scope.current === token, [token]);
  const read = useCallback(async () => {
    const snapshot = await getCitadelVaultSnapshot(citadelId);
    if (snapshot.citadelId !== citadelId) throw new Error("The Vault review belongs to a different Citadel.");
    return snapshot;
  }, [citadelId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setState({ token, snapshot: null, loading: true, error: null, reviewRequired: false });
    void read().then((snapshot) => {
      if (!cancelled && isCurrent()) setState({ token, snapshot, loading: false, error: null, reviewRequired: false });
    }).catch((error: unknown) => {
      if (!cancelled && isCurrent()) setState({ token, snapshot: null, loading: false, error: getErrorMessage(error), reviewRequired: false });
    });
    return () => { cancelled = true; };
  }, [isCurrent, read, token]);
  const snapshot = state.token === token ? state.snapshot : null;
  const ready = Boolean(snapshot) && !state.loading && !state.reviewRequired && !busy && snapshot?.record?.lifecycleStatus !== "archived";
  const reload = useCallback(async () => {
    if (!isCurrent() || busyRef.current || reloadRef.current) return;
    reloadRef.current = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const current = await read();
      if (isCurrent()) setState((previous) => ({ ...previous, token, snapshot: current, loading: false, error: null }));
    } catch (error) {
      if (isCurrent()) setState((current) => ({ ...current, loading: false, error: getErrorMessage(error) }));
    } finally { reloadRef.current = false; }
  }, [isCurrent, read, token]);
  const run = useCallback(async (expectedRevision: string | undefined, write: () => Promise<CitadelVaultSnapshot>) => {
    if (!isCurrent() || !ready || !expectedRevision || busyRef.current || reloadRef.current) return null;
    busyRef.current = true; setBusy(true);
    try {
      const saved = await write();
      if (!isCurrent()) return null;
      if (saved.citadelId !== citadelId) throw new Error("The saved Vault belongs to a different Citadel.");
      setState({ token, snapshot: saved, loading: false, error: null, reviewRequired: false });
      return saved;
    } catch (error) {
      if (!isCurrent()) return null;
      if (isApiRequestError(error) && error.status === 409) {
        setState({ token, snapshot: null, loading: true, error: describeVaultError(error), reviewRequired: true });
        try {
          const current = await read();
          if (isCurrent()) setState({ token, snapshot: current, loading: false, error: null, reviewRequired: true });
        } catch (refreshError) {
          if (isCurrent()) setState({ token, snapshot: null, loading: false, error: `The change was rejected. Current metadata could not be loaded: ${getErrorMessage(refreshError)}`, reviewRequired: true });
        }
      } else setState((current) => ({ ...current, error: describeVaultError(error) }));
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [citadelId, isCurrent, read, ready, token]);
  return { snapshot, loading: state.token !== token || state.loading, error: state.token === token ? state.error : null,
    reviewRequired: state.token === token && state.reviewRequired, busy, ready, run, isCurrent, reload,
    acceptReview: () => { if (snapshot && !state.loading) setState((current) => ({ ...current, reviewRequired: false, error: null })); } };
}
