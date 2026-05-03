import type { DevDiagnosticsEvent, DevDiagnosticsLevel, DevDiagnosticsListResponse } from "@goatcitadel/contracts";

import { recordClientDiagnostic, setDevDiagnosticsGatewayReachable } from "../state/dev-diagnostics-store";
import { buildGatewayUrl, clearGatewayAuthState, readStoredGatewayAuthState, request } from "./client-core.js";
import { isApiRequestError } from "./http-internal";
import { computeReconnectDelay, isSseBridgeNotNeededError, issueSseBridgeToken } from "./sse-bridge.js";

export async function fetchDevDiagnostics(
  params: {
    level?: DevDiagnosticsLevel;
    category?: string;
    correlationId?: string;
    limit?: number;
  } = {},
): Promise<DevDiagnosticsListResponse> {
  const query = new URLSearchParams();
  if (params.level) {
    query.set("level", params.level);
  }
  if (params.category) {
    query.set("category", params.category);
  }
  if (params.correlationId) {
    query.set("correlationId", params.correlationId);
  }
  if (params.limit) {
    query.set("limit", String(params.limit));
  }
  return request<DevDiagnosticsListResponse>(`/api/v1/dev/diagnostics${query.size > 0 ? `?${query.toString()}` : ""}`);
}

export function connectDevDiagnosticsStream(onEvent: (event: DevDiagnosticsEvent) => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  let source: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  let closed = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) {
      return;
    }
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) {
      return;
    }
    reconnectAttempts += 1;
    setDevDiagnosticsGatewayReachable(false);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, computeReconnectDelay(reconnectAttempts));
  };

  const buildDiagnosticsStreamUrl = async () => {
    const url = new URL(buildGatewayUrl("/api/v1/dev/diagnostics/stream"));
    url.searchParams.set("replay", "50");
    const auth = readStoredGatewayAuthState();
    if (!auth) {
      return url.toString();
    }
    if (
      auth.mode === "token" ||
      auth.mode === "basic" ||
      Boolean(auth.token?.trim()) ||
      Boolean(auth.username && auth.password)
    ) {
      try {
        const issued = await issueSseBridgeToken("dev:diagnostics:stream");
        url.searchParams.set("sse_token", issued.token);
      } catch (error) {
        if (isSseBridgeNotNeededError(error)) {
          clearGatewayAuthState();
          return url.toString();
        }
        if (!(isApiRequestError(error) && error.status === 400)) {
          throw error;
        }
      }
    }
    return url.toString();
  };

  const connect = async () => {
    if (closed || source) {
      return;
    }
    try {
      const url = await buildDiagnosticsStreamUrl();
      if (closed) {
        return;
      }
      source = new EventSource(url);
      source.onopen = () => {
        reconnectAttempts = 0;
        setDevDiagnosticsGatewayReachable(true);
        recordClientDiagnostic({
          level: "info",
          category: "sse",
          event: "dev_diagnostics.open",
          message: "Developer diagnostics stream connected",
        });
      };
      source.onmessage = (event) => {
        try {
          onEvent(JSON.parse(event.data) as DevDiagnosticsEvent);
          setDevDiagnosticsGatewayReachable(true);
        } catch {
          // ignore malformed diagnostics
        }
      };
      source.onerror = () => {
        if (!source) {
          return;
        }
        source.close();
        source = null;
        recordClientDiagnostic({
          level: "warn",
          category: "sse",
          event: "dev_diagnostics.error",
          message: "Developer diagnostics stream disconnected",
        });
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  };

  void connect();
  return () => {
    closed = true;
    clearReconnectTimer();
    source?.close();
    source = null;
  };
}
