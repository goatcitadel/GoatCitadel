import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGoogleWorkspaceCapability,
  type GoogleWorkspaceCapability,
  type GoogleWorkspaceOAuthStartResponse,
  type GoogleWorkspaceOAuthStatus,
} from "@goatcitadel/contracts";
import {
  completeGoogleWorkspaceOAuth,
  disconnectGoogleWorkspaceOAuth,
  fetchGoogleWorkspaceOAuthStatus,
  startGoogleWorkspaceOAuth,
} from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { subscribeGoogleOAuthReturn } from "./google-oauth-return";

export interface GoogleSignInOutcome {
  tone: "info" | "error";
  message: string;
}

export const googleWorkspaceStatusKey = (connectionId: string) =>
  ["settings", "google-workspace-oauth", connectionId] as const;

/**
 * One connection's Google sign-in: readiness, the reviewed Connect flow, and Disconnect. The pending
 * request lives only in this tab's memory; Google's redirect is completed here when it comes back.
 */
export function useGoogleWorkspaceSignIn(connectionId: string, onChanged: () => void) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: googleWorkspaceStatusKey(connectionId),
    queryFn: () => fetchGoogleWorkspaceOAuthStatus(connectionId),
  });
  const [flow, setFlow] = useState<GoogleWorkspaceOAuthStartResponse>();
  const [busy, setBusy] = useState<"start" | "complete" | "disconnect">();
  const [outcome, setOutcome] = useState<GoogleSignInOutcome>();
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const settle = useCallback(
    (next: GoogleWorkspaceOAuthStatus) => {
      queryClient.setQueryData(googleWorkspaceStatusKey(connectionId), next);
      void queryClient.invalidateQueries({ queryKey: ["settings", "integration-connections"] });
      changed.current();
    },
    [connectionId, queryClient],
  );

  const start = useCallback(
    async (capabilities: GoogleWorkspaceCapability[], clientSecret: string) => {
      setBusy("start");
      setOutcome(undefined);
      try {
        const secret = clientSecret.trim();
        setFlow(
          await startGoogleWorkspaceOAuth(connectionId, { capabilities, ...(secret ? { clientSecret: secret } : {}) }),
        );
        return true;
      } catch (error) {
        setOutcome({ tone: "error", message: `Connect Google did not start: ${describeApiError(error).summary}` });
        return false;
      } finally {
        setBusy(undefined);
        void status.refetch();
      }
    },
    [connectionId, status],
  );

  const complete = useCallback(
    async (state: string, code: string, requested: GoogleWorkspaceCapability[]) => {
      setBusy("complete");
      try {
        const next = await completeGoogleWorkspaceOAuth(connectionId, { state, code });
        settle(next);
        setOutcome(describeConnected(next, requested));
      } catch (error) {
        setOutcome({ tone: "error", message: `Google sign-in did not finish: ${describeApiError(error).summary}` });
      } finally {
        setBusy(undefined);
      }
    },
    [connectionId, settle],
  );

  const pendingState = flow?.state;
  const requested = useRef<GoogleWorkspaceCapability[]>([]);
  requested.current = flow?.capabilities ?? requested.current;
  useEffect(() => {
    if (!pendingState) return undefined;
    return subscribeGoogleOAuthReturn((result) => {
      if (result.state !== pendingState) return;
      setFlow(undefined);
      if (result.code) void complete(result.state, result.code, requested.current);
      else setOutcome({ tone: "error", message: `Google did not grant access (${result.error}). Nothing changed.` });
    });
  }, [pendingState, complete]);

  const disconnect = useCallback(async () => {
    setBusy("disconnect");
    setOutcome(undefined);
    try {
      const result = await disconnectGoogleWorkspaceOAuth(connectionId);
      settle(result.status);
      setOutcome({ tone: result.revoked ? "info" : "error", message: result.message });
    } catch (error) {
      setOutcome({ tone: "error", message: `Disconnect did not finish: ${describeApiError(error).summary}` });
    } finally {
      setBusy(undefined);
    }
  }, [connectionId, settle]);

  return {
    status,
    flow,
    busy,
    outcome,
    start,
    disconnect,
    cancel: () => setFlow(undefined),
  };
}

function describeConnected(
  status: GoogleWorkspaceOAuthStatus,
  requested: readonly GoogleWorkspaceCapability[],
): GoogleSignInOutcome {
  if (!status.connected) {
    return { tone: "error", message: "Google sent you back, but the sign-in is not usable. Connect Google again." };
  }
  const label = (capability: GoogleWorkspaceCapability) => getGoogleWorkspaceCapability(capability).label;
  const allowed = status.capabilities
    .filter((item) => item.enabled && item.granted)
    .map((item) => label(item.capability));
  const refused = requested
    .filter((capability) => !status.capabilities.some((item) => item.capability === capability && item.granted))
    .map(label);
  const account = status.accountLabel ? ` as ${status.accountLabel}` : "";
  return {
    tone: refused.length ? "error" : "info",
    message:
      `Connected to Google${account}. Allowed: ${allowed.length ? allowed.join(", ") : "nothing"}.` +
      (refused.length ? ` Google did not grant ${refused.join(", ")}, so those stay off.` : ""),
  };
}
