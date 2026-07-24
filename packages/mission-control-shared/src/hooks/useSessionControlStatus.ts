import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionControlDetailResponse } from "@goatcitadel/contracts";
import { fetchSessionControlDetail } from "../api/session-control-operator";
import { useRefreshSubscription } from "./useRefreshSubscription";

export interface SessionControlStatusState {
  readonly data: SessionControlDetailResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

/**
 * Operator-auth poll of the content-free session-control status for one Chat
 * session. Keeps the Chat banner and Ops panel truthful: it re-reads canonical
 * server state on the shared refresh cadence and never infers ownership from a
 * failed read. Passing `null` (no session selected) leaves it idle.
 */
export function useSessionControlStatus(sessionId: string | null): SessionControlStatusState {
  const [data, setData] = useState<SessionControlDetailResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const reload = useCallback(async () => {
    if (!sessionId) {
      return;
    }
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setError(null);
    try {
      const next = await fetchSessionControlDetail(sessionId);
      if (loadSequenceRef.current === loadId) {
        setData(next);
      }
    } catch {
      if (loadSequenceRef.current === loadId) {
        // H1 fail-closed: RETAIN the last successful projection on a transient
        // re-poll failure and surface a non-fatal caveat instead of nulling it.
        // Nulling here would drop a known external-control lock — the deriver maps
        // null → operator/unlocked — and re-enable operator send while an external
        // client still owns the session. Only the never-loaded initial state stays
        // null (data was never set), which is the correct unlocked fallback; a later
        // successful reload clears this error and replaces the retained data.
        setError("The session control status is unavailable.");
      }
    } finally {
      if (loadSequenceRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      loadSequenceRef.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setData(null);
    setError(null);
    void reload();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [reload, sessionId]);

  // Session control changes (handoff / heartbeat health / revoke) ride the chat
  // refresh topic; a slower system poll keeps a stale banner from lingering.
  useRefreshSubscription("chat", reload);
  useRefreshSubscription("system", reload, { staleMs: 30_000, pollIntervalMs: 30_000 });

  return useMemo(() => ({ data, loading, error, reload }), [data, loading, error, reload]);
}
