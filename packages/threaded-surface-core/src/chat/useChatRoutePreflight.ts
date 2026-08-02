import type {
  ChatSessionPrefsRecord,
  RoutingPreflightAction,
  RoutingPreflightRequest,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { preflightChatRoute } from "@goatcitadel/mission-control-shared/api/client";
import type { OutboundRequestPrefsSnapshot } from "./useChatSurfaceOrchestration";

const PREFLIGHT_TTL_MS = 30_000;

function stableHash(value: unknown): string {
  return JSON.stringify(value);
}

function buildPreflightRequest(input: {
  action: RoutingPreflightAction;
  turnId?: string | null;
  content?: string;
  prefs: ChatSessionPrefsRecord | null;
  surfaceMode?: ChatSessionPrefsRecord["mode"];
  fullWebAccess?: boolean;
  requestPrefs?: OutboundRequestPrefsSnapshot;
}): RoutingPreflightRequest {
  const prefsOverride = input.requestPrefs
    ? {
        mode: input.requestPrefs.mode,
        providerId: input.requestPrefs.providerId,
        model: input.requestPrefs.model,
        webMode: input.requestPrefs.webMode,
        memoryMode: input.requestPrefs.memoryMode,
        thinkingLevel: input.requestPrefs.thinkingLevel,
        speedMode: input.requestPrefs.speedMode,
        subagentPolicy: input.requestPrefs.subagentPolicy,
      }
    : input.prefs
      ? {
          mode: input.surfaceMode ?? input.prefs.mode,
          providerId: input.prefs.providerId,
          model: input.prefs.model,
          webMode: input.prefs.webMode,
          memoryMode: input.prefs.memoryMode,
          thinkingLevel: input.prefs.thinkingLevel,
          speedMode: input.prefs.speedMode,
          subagentPolicy: input.prefs.subagentPolicy,
        }
      : undefined;
  const fullWebAccess = input.requestPrefs?.fullWebAccess ?? Boolean(input.fullWebAccess);
  return {
    action: input.action,
    turnId: input.turnId ?? undefined,
    content: input.content?.trim() || undefined,
    prefsOverride,
    ...(fullWebAccess ? { fullWebAccess: true } : {}),
  };
}

export function useChatRoutePreflight(input: {
  sessionId: string | null;
  prefs: ChatSessionPrefsRecord | null;
  content?: string;
  surfaceMode?: ChatSessionPrefsRecord["mode"];
  fullWebAccess?: boolean;
  displayAction: RoutingPreflightAction;
  displayTurnId?: string | null;
  enabled?: boolean;
}) {
  const { sessionId, prefs, content, surfaceMode, fullWebAccess, displayAction, displayTurnId, enabled = true } = input;
  const cacheRef = useRef(new Map<string, { fetchedAt: number; result: RoutingPreflightResult }>());
  const [result, setResult] = useState<RoutingPreflightResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayRequest = useMemo(
    () =>
      sessionId
        ? buildPreflightRequest({
            action: displayAction,
            turnId: displayTurnId,
            content,
            prefs,
            surfaceMode,
            fullWebAccess,
          })
        : null,
    [content, displayAction, displayTurnId, fullWebAccess, prefs, sessionId, surfaceMode],
  );
  const displayKey = useMemo(
    () => (sessionId && displayRequest ? `${sessionId}:${stableHash(displayRequest)}` : null),
    [displayRequest, sessionId],
  );

  const fetchPreflight = useCallback(
    async (request: RoutingPreflightRequest, options: { force?: boolean; sessionId: string }) => {
      const targetSessionId = options.sessionId;
      const cacheKey = `${targetSessionId}:${stableHash(request)}`;
      const cached = cacheRef.current.get(cacheKey);
      if (!options?.force && cached && Date.now() - cached.fetchedAt < PREFLIGHT_TTL_MS) {
        return cached.result;
      }
      const next = await preflightChatRoute(targetSessionId, request, {
        originSurface: request.prefsOverride?.mode,
      });
      cacheRef.current.set(cacheKey, {
        fetchedAt: Date.now(),
        result: next,
      });
      return next;
    },
    [],
  );

  useEffect(() => {
    const displaySessionId = sessionId;
    if (!displayRequest || !displayKey || !enabled || !displaySessionId) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setResult(null);
    setError(null);
    setLoading(true);
    const fetchDisplayPreflight = () => {
      void fetchPreflight(displayRequest, { sessionId: displaySessionId })
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
    };
    const debounce = displayRequest.content ? setTimeout(fetchDisplayPreflight, 250) : undefined;
    if (!debounce) {
      fetchDisplayPreflight();
    }
    return () => {
      cancelled = true;
      if (debounce) {
        clearTimeout(debounce);
      }
    };
  }, [displayKey, displayRequest, enabled, fetchPreflight, sessionId]);

  const ensureFreshPreflight = useCallback(
    async (override: {
      action: RoutingPreflightAction;
      turnId?: string | null;
      content?: string;
      sessionId?: string | null;
      requestPrefs?: OutboundRequestPrefsSnapshot;
      force?: boolean;
    }) => {
      const targetSessionId = override.sessionId ?? sessionId;
      if (!targetSessionId) {
        return null;
      }
      const request = buildPreflightRequest({
        action: override.action,
        turnId: override.turnId,
        content: override.content,
        prefs,
        surfaceMode,
        fullWebAccess,
        requestPrefs: override.requestPrefs,
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
    [displayKey, fetchPreflight, fullWebAccess, prefs, sessionId, surfaceMode],
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
