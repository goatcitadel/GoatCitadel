import type {
  ChatSessionPrefsRecord,
  RoutingPreflightAction,
  RoutingPreflightRequest,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preflightChatRoute } from "@goatcitadel/mission-control-shared/api/client";

const PREFLIGHT_TTL_MS = 30_000;

function stableHash(value: unknown): string {
  return JSON.stringify(value);
}

function buildPreflightRequest(input: {
  action: RoutingPreflightAction;
  turnId?: string | null;
  prefs: ChatSessionPrefsRecord | null;
}): RoutingPreflightRequest {
  const prefsOverride = input.prefs
    ? {
        mode: input.prefs.mode,
        providerId: input.prefs.providerId,
        model: input.prefs.model,
        webMode: input.prefs.webMode,
        memoryMode: input.prefs.memoryMode,
        thinkingLevel: input.prefs.thinkingLevel,
      }
    : undefined;
  return {
    action: input.action,
    turnId: input.turnId ?? undefined,
    prefsOverride,
  };
}

export function useChatRoutePreflight(input: {
  sessionId: string | null;
  prefs: ChatSessionPrefsRecord | null;
  displayAction: RoutingPreflightAction;
  displayTurnId?: string | null;
  enabled?: boolean;
}) {
  const { sessionId, prefs, displayAction, displayTurnId, enabled = true } = input;
  const cacheRef = useRef(new Map<string, { fetchedAt: number; result: RoutingPreflightResult }>());
  const [result, setResult] = useState<RoutingPreflightResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayRequest = useMemo(
    () => (sessionId ? buildPreflightRequest({ action: displayAction, turnId: displayTurnId, prefs }) : null),
    [displayAction, displayTurnId, prefs, sessionId],
  );
  const displayKey = useMemo(
    () => (sessionId && displayRequest ? `${sessionId}:${stableHash(displayRequest)}` : null),
    [displayRequest, sessionId],
  );

  const fetchPreflight = useCallback(
    async (request: RoutingPreflightRequest, options?: { force?: boolean; sessionId?: string | null }) => {
      const targetSessionId = options?.sessionId ?? sessionId;
      if (!targetSessionId) {
        return null;
      }
      const cacheKey = `${targetSessionId}:${stableHash(request)}`;
      const cached = cacheRef.current.get(cacheKey);
      if (!options?.force && cached && Date.now() - cached.fetchedAt < PREFLIGHT_TTL_MS) {
        return cached.result;
      }
      const next = await preflightChatRoute(targetSessionId, request);
      cacheRef.current.set(cacheKey, {
        fetchedAt: Date.now(),
        result: next,
      });
      return next;
    },
    [sessionId],
  );

  useEffect(() => {
    if (!displayRequest || !displayKey || !enabled) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setResult(null);
    setError(null);
    setLoading(true);
    void fetchPreflight(displayRequest)
      .then((next) => {
        if (cancelled) {
          return;
        }
        setResult(next);
        setError(null);
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [displayKey, displayRequest, enabled, fetchPreflight]);

  const ensureFreshPreflight = useCallback(
    async (override: {
      action: RoutingPreflightAction;
      turnId?: string | null;
      sessionId?: string | null;
      force?: boolean;
    }) => {
      const targetSessionId = override.sessionId ?? sessionId;
      if (!targetSessionId) {
        return null;
      }
      const request = buildPreflightRequest({
        action: override.action,
        turnId: override.turnId,
        prefs,
      });
      const cacheKey = `${targetSessionId}:${stableHash(request)}`;
      const cached = cacheRef.current.get(cacheKey);
      const stale = !cached || Date.now() - cached.fetchedAt >= PREFLIGHT_TTL_MS;
      const next = await fetchPreflight(request, { force: override.force || stale, sessionId: targetSessionId });
      if (displayKey === cacheKey) {
        setResult(next);
        setError(null);
      }
      return next;
    },
    [displayKey, fetchPreflight, prefs, sessionId],
  );

  const resultHash = useMemo(() => (result ? stableHash(result) : null), [result]);

  return {
    result,
    resultHash,
    loading,
    error,
    ensureFreshPreflight,
  };
}
