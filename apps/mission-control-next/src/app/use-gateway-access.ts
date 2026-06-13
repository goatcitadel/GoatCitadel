import { useCallback, useEffect, useRef, useState } from "react";
import {
  consumeGatewayAccessBootstrapFromLocation,
  getGatewayApiBaseUrl,
  preflightGatewayAccess,
  type GatewayAccessPreflightResult,
} from "@goatcitadel/mission-control-shared/api/shell-client";

/*
 * W4.4 (ship punchlist): gateway access preflight extracted from the shell.
 *
 * Owns the `gatewayAccess` view state, the `gatewayBusy` flag, and the
 * `retryGatewayAccess` callback used by both the GatewayAccessGate and the
 * shell's mount-time preflight. Caller can re-run the preflight on demand
 * (e.g. when the retry button in the access gate is clicked).
 */

// Auto-recovery backoff for transient gateway outages. The dev-supervisor
// restarts the gateway on source changes, leaving :8787 briefly refusing
// connections; without this the shell latched onto "unreachable" until the user
// clicked retry. While the preflight reports "unreachable" we re-probe on an
// exponential backoff so the shell self-heals when the gateway returns. Probing
// stops the moment access resolves to any non-"unreachable" state, and terminal
// states (e.g. "misconfigured") are intentionally left for the user to act on.
const AUTO_RETRY_BASE_MS = 2_000;
const AUTO_RETRY_MAX_MS = 15_000;

export type GatewayAccessViewState =
  | GatewayAccessPreflightResult
  | {
      status: "checking";
      message: string;
      healthDetail?: string;
      authMode?: "none" | "basic" | "token";
    };

export interface UseGatewayAccessResult {
  gatewayAccess: GatewayAccessViewState;
  gatewayBusy: boolean;
  autoRetryPending: boolean;
  retryGatewayAccess: () => Promise<void>;
}

export function useGatewayAccess(): UseGatewayAccessResult {
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and Mission Control access policy.",
  });
  const [gatewayBusy, setGatewayBusy] = useState(true);
  const autoRetryDelayRef = useRef(AUTO_RETRY_BASE_MS);

  const retryGatewayAccess = useCallback(async () => {
    setGatewayBusy(true);
    try {
      const bootstrap = consumeGatewayAccessBootstrapFromLocation();
      const next = await preflightGatewayAccess({ bootstrap });
      setGatewayAccess(next);
    } catch (error) {
      setGatewayAccess({
        status: "unreachable",
        message: error instanceof Error ? error.message : "Gateway preflight failed.",
        healthDetail: getGatewayApiBaseUrl(),
      });
    } finally {
      setGatewayBusy(false);
    }
  }, []);

  useEffect(() => {
    void retryGatewayAccess();
  }, [retryGatewayAccess]);

  // Self-heal from transient gateway restarts without a manual retry click.
  useEffect(() => {
    if (gatewayAccess.status !== "unreachable") {
      autoRetryDelayRef.current = AUTO_RETRY_BASE_MS;
      return;
    }
    if (gatewayBusy) {
      return;
    }
    const delay = autoRetryDelayRef.current;
    const timer = setTimeout(() => {
      autoRetryDelayRef.current = Math.min(delay * 2, AUTO_RETRY_MAX_MS);
      void retryGatewayAccess();
    }, delay);
    return () => clearTimeout(timer);
  }, [gatewayAccess, gatewayBusy, retryGatewayAccess]);

  // While unreachable the effect above keeps re-probing, so surface that as a
  // pending auto-retry for the access gate's "will retry automatically" note.
  const autoRetryPending = gatewayAccess.status === "unreachable";

  return { gatewayAccess, gatewayBusy, autoRetryPending, retryGatewayAccess };
}
