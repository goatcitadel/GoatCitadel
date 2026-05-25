import { useCallback, useEffect, useState } from "react";
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
  retryGatewayAccess: () => Promise<void>;
}

export function useGatewayAccess(): UseGatewayAccessResult {
  const [gatewayAccess, setGatewayAccess] = useState<GatewayAccessViewState>({
    status: "checking",
    message: "Verifying gateway reachability and Mission Control access policy.",
  });
  const [gatewayBusy, setGatewayBusy] = useState(true);

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

  return { gatewayAccess, gatewayBusy, retryGatewayAccess };
}
