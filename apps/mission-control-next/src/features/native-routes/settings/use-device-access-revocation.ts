import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DeviceAccessGrantRecord } from "@goatcitadel/contracts";
import { fetchDeviceAccessGrants, revokeDeviceAccessGrant } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

type Attempt = { state: "checking" | "submitted" | "revoked" | "uncertain"; message: string };
// Presentation locks only. A lost response must not become permission to retry on navigation.
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
let version = 0;
function publish(id: string, attempt?: Attempt) {
  if (attempt) attempts.set(id, attempt);
  else attempts.delete(id);
  version += 1;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const datePresent = (value?: string) => Boolean(value && Number.isFinite(Date.parse(value)));
export function deviceGrantCanBeRevoked(grant: DeviceAccessGrantRecord, now = Date.now()) {
  return Boolean(
    grant.grantId?.trim() &&
    grant.requestId?.trim() &&
    grant.actorId?.trim() &&
    datePresent(grant.createdAt) &&
    !grant.revokedAt &&
    (!grant.expiresAt || (datePresent(grant.expiresAt) && Date.parse(grant.expiresAt) > now)),
  );
}
/** Activity timestamps can advance while a review is open; the granted identity cannot. */
export function sameDeviceGrant(reviewed: DeviceAccessGrantRecord, current?: DeviceAccessGrantRecord) {
  return Boolean(
    current &&
    [
      "grantId",
      "requestId",
      "actorId",
      "deviceLabel",
      "deviceType",
      "platform",
      "principalPurpose",
      "grantedBy",
      "createdAt",
      "expiresAt",
    ].every((key) => reviewed[key as keyof DeviceAccessGrantRecord] === current[key as keyof DeviceAccessGrantRecord]),
  );
}

export function useDeviceAccessRevocation() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const [reviewed, setReviewed] = useState<DeviceAccessGrantRecord | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; message: string } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  const attemptFor = (id: string) => attempts.get(id);
  const pending = Boolean(reviewed && ["checking", "submitted"].includes(attemptFor(reviewed.grantId)?.state ?? ""));
  function review(grant: DeviceAccessGrantRecord) {
    if (!deviceGrantCanBeRevoked(grant) || attempts.has(grant.grantId) || pending) return;
    generation.current += 1;
    setNotice(null);
    setReviewed({ ...grant });
  }
  function cancel() {
    if (reviewed && attempts.get(reviewed.grantId)?.state === "submitted") return;
    generation.current += 1;
    setReviewed(null);
  }
  async function confirm(): Promise<boolean> {
    const grant = reviewed;
    if (!grant || attempts.has(grant.grantId) || !deviceGrantCanBeRevoked(grant)) return false;
    const token = generation.current;
    const isCurrent = () => mounted.current && generation.current === token;
    publish(grant.grantId, { state: "checking", message: "Checking the current device grant…" });
    let dispatched = false;
    try {
      const response = await fetchDeviceAccessGrants("all");
      if (!isCurrent()) return false;
      const matches = response.items.filter((item) => item.grantId === grant.grantId);
      if (matches.length !== 1 || !sameDeviceGrant(grant, matches[0]) || !deviceGrantCanBeRevoked(matches[0]!)) {
        setReviewed(null);
        setNotice({
          tone: "warning",
          message: "The device grant changed or is no longer active. Refresh and review it again.",
        });
        return false;
      }
      dispatched = true;
      publish(grant.grantId, { state: "submitted", message: "Revoking the reviewed device grant…" });
      const result = await revokeDeviceAccessGrant(grant.grantId);
      if (!sameDeviceGrant(grant, result?.grant) || !datePresent(result?.grant?.revokedAt)) {
        throw new Error("The Gateway response did not confirm the reviewed device revocation.");
      }
      publish(grant.grantId, { state: "revoked", message: "Device access revoked." });
      if (isCurrent()) {
        setReviewed(null);
        setNotice({ tone: "success", message: "Device access revoked." });
      }
      return true;
    } catch (error) {
      const message = dispatched
        ? "Revocation outcome is uncertain. Further attempts are locked in this app session. Refresh devices to inspect the current grant."
        : `Could not check the device grant. ${describeApiError(error).summary}`;
      if (dispatched) publish(grant.grantId, { state: "uncertain", message });
      if (isCurrent()) {
        setReviewed(null);
        setNotice({ tone: dispatched ? "warning" : "error", message });
      }
      return false;
    } finally {
      if (!dispatched) publish(grant.grantId);
    }
  }
  return { reviewed, notice, pending, review, cancel, confirm, attemptFor };
}

export function __resetDeviceAccessRevocationsForTests() {
  attempts.clear();
  version += 1;
  for (const listener of listeners) listener();
}
