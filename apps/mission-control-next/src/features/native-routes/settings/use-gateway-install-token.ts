import { useEffect, useRef, useState } from "react";
import {
  fetchSettings,
  resolveGatewayInstallToken,
  type RuntimeSettingsResponse,
} from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { authReady, authSnapshot, beginAuthAttempt, finishAuthAttempt } from "./gateway-auth-state";

/** The existing installation-token owner has no revision-CAS input. */
export function useGatewayInstallToken(options: {
  key: string;
  settings?: RuntimeSettingsResponse;
  locked: boolean;
  active: boolean;
  available: boolean;
  reload: () => Promise<unknown>;
}) {
  const [review, setReview] = useState<RuntimeSettingsResponse | null>(null);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef({ mounted: false, epoch: 0, identity: "" });
  const identity = authSnapshot([
    options.key,
    options.active,
    options.available,
    options.settings?.revision,
    options.settings?.auth,
  ]);
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.epoch += 1;
  }
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.epoch += 1;
    };
  }, []);
  useEffect(() => {
    if (!options.active) setToken("");
  }, [options.active]);
  useEffect(() => {
    if (!token) return;
    const timer = globalThis.setTimeout(() => setToken(""), 30_000);
    return () => globalThis.clearTimeout(timer);
  }, [token]);
  const eligible =
    options.active &&
    options.available &&
    !options.locked &&
    authReady(options.settings) &&
    options.settings.auth.mode === "token";
  const reviewCurrent = Boolean(
    review &&
    eligible &&
    review.revision === options.settings?.revision &&
    authSnapshot(review.auth) === authSnapshot(options.settings?.auth),
  );
  async function confirm() {
    if (!review || !reviewCurrent || !beginAuthAttempt(options.key)) return;
    const intent = review,
      epoch = live.current.epoch;
    const current = () =>
      live.current.mounted && live.current.epoch === epoch && options.key === `access:${getGatewayApiBaseUrl()}:auth`;
    let dispatched = false,
      acknowledged = false;
    setReview(null);
    setToken("");
    setMessage(null);
    try {
      const latest = await fetchSettings();
      if (!current()) return;
      if (
        !authReady(latest) ||
        latest.revision !== intent.revision ||
        authSnapshot(latest.auth) !== authSnapshot(intent.auth)
      ) {
        setMessage("Authentication changed. Refresh and review before resolving an install token.");
        return;
      }
      dispatched = true;
      const receipt = await resolveGatewayInstallToken({ generateWhenMissing: true, persistToEnv: false });
      if (options.key !== `access:${getGatewayApiBaseUrl()}:auth`) throw new Error("Gateway installation changed");
      if (
        !receipt ||
        typeof receipt.persistedToEnv !== "boolean" ||
        receipt.persistedToEnv ||
        !Array.isArray(receipt.warnings) ||
        !["none", "explicit", "env", "inline", "runtime", "generated"].includes(receipt.source) ||
        (receipt.source !== "none" && !receipt.token?.trim()) ||
        (receipt.source === "none" && receipt.token)
      )
        throw new Error("Unbound token response");
      const after = await fetchSettings();
      if (
        !authReady(after) ||
        after.auth.mode !== "token" ||
        after.auth.allowLoopbackBypass !== intent.auth.allowLoopbackBypass ||
        after.revision !== intent.revision ||
        (receipt.token && !after.auth.tokenConfigured)
      )
        throw new Error("Authentication changed during token resolution");
      acknowledged = true;
      if (current()) {
        setToken(receipt.token ?? "");
        setMessage(
          receipt.token
            ? "Install token resolved by the Gateway. The value is visible only in this editor for 30 seconds."
            : "The Gateway did not return an install token. Refresh authentication posture before another attempt.",
        );
        try {
          await options.reload();
        } catch {
          /* Receipt is already acknowledged. */
        }
      }
    } catch {
      if (!dispatched && current())
        setMessage("Current authentication could not be verified. No install-token request was sent.");
    } finally {
      finishAuthAttempt(options.key, dispatched && !acknowledged);
    }
  }
  return {
    eligible,
    review,
    reviewCurrent,
    token,
    message,
    confirm,
    requestReview: () => {
      if (eligible && options.settings) setReview(structuredClone(options.settings));
    },
    cancel: () => setReview(null),
    hide: () => setToken(""),
  };
}
