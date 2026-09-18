import { useCallback, useEffect, useRef, useState } from "react";
import type { CitadelAccessSnapshot } from "@goatcitadel/contracts";
import { getCitadelAccessSnapshot, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../shared/native-helpers";

/** A scope-bound review and its own acknowledgement. Conflicts never retry a write. */
export function useCitadelAccessReview(citadelId: string) {
  const scope = useRef({ citadelId });
  if (scope.current.citadelId !== citadelId) scope.current = { citadelId };
  const token = scope.current;
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const [state, setState] = useState<{ token: object; snapshot: CitadelAccessSnapshot | null; loading: boolean; error: string | null; reviewRequired: boolean }>({ token, snapshot: null, loading: true, error: null, reviewRequired: false });
  const [busy, setBusy] = useState(false);
  const isCurrent = useCallback(() => mounted.current && scope.current === token, [token]);
  const read = useCallback(async () => {
    const snapshot = await getCitadelAccessSnapshot(citadelId);
    if (snapshot.citadelId !== citadelId) throw new Error("The access review belongs to a different Citadel.");
    return snapshot;
  }, [citadelId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
  const ready = Boolean(snapshot) && !state.loading && !state.reviewRequired && !busy
    && snapshot?.structure.record?.lifecycleStatus !== "archived";
  const run = useCallback(async (expectedRevision: string | undefined, write: () => Promise<CitadelAccessSnapshot>) => {
    if (!isCurrent() || !ready || !expectedRevision || busyRef.current) return null;
    busyRef.current = true; setBusy(true);
    try {
      const saved = await write();
      if (!isCurrent()) return null;
      if (saved.citadelId !== citadelId) throw new Error("The saved access rules belong to a different Citadel.");
      setState({ token, snapshot: saved, loading: false, error: null, reviewRequired: false });
      return saved;
    } catch (error) {
      if (!isCurrent()) return null;
      if (isApiRequestError(error) && error.status === 409) {
        setState({ token, snapshot: null, loading: true, error: getErrorMessage(error), reviewRequired: true });
        try {
          const current = await read();
          if (isCurrent()) setState({ token, snapshot: current, loading: false, error: "Access rules changed. Review the current rules, then explicitly retry your change.", reviewRequired: true });
        } catch (refreshError) {
          if (isCurrent()) setState({ token, snapshot: null, loading: false, error: `The change was rejected and the current rules could not be loaded: ${getErrorMessage(refreshError)}`, reviewRequired: true });
        }
      } else setState((current) => ({ ...current, error: getErrorMessage(error) }));
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [citadelId, isCurrent, read, ready, token]);
  return { snapshot, loading: state.token !== token || state.loading, error: state.token === token ? state.error : null,
    reviewRequired: state.token === token && state.reviewRequired, busy, ready, run, isCurrent,
    acceptReview: () => { if (snapshot && !state.loading) setState((current) => ({ ...current, reviewRequired: false, error: null })); } };
}
