import { useSyncExternalStore } from "react";
import type { AddonStatusRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  disableAddon,
  enableAddon,
  fetchAddonStatus,
  fetchInstalledAddons,
  installAddon,
  launchAddon,
  stopAddon,
  uninstallAddon,
  updateAddon,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  addonActionAvailable,
  addonRecordsEqual,
  assertAddonReceipt,
  assertAddonStatus,
  type AddonAction,
} from "./addon-owner-binding";

type Attempt = { phase: "idle" | "pending" | "uncertain"; message?: string };
const IDLE: Attempt = { phase: "idle" };
const attempts = new Map<string, Attempt>(),
  listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function setAttempt(base: string, value: Attempt) {
  attempts.set(base, value);
  for (const listener of listeners) listener();
}
const attempt = (base: string) => attempts.get(base) ?? IDLE;
export function useAddonMutation(base: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => attempt(base),
    () => IDLE,
  );
  return { ...value, locked: value.phase !== "idle", pending: value.phase === "pending" };
}
export type AddonReview = { action: AddonAction; status: AddonStatusRecord; base: string; current: () => boolean };
export type AddonCommitResult =
  | { kind: "confirmed"; status: AddonStatusRecord }
  | { kind: "cancelled" | "blocked" | "uncertain"; message: string };

/** Shared app-session admission; it neither grants host authority nor invents an owner CAS contract. */
export async function commitAddonReview(review: AddonReview): Promise<AddonCommitResult> {
  const { base, status: before, action } = review,
    addonId = before.addon.addonId;
  if (attempt(base).phase !== "idle")
    return { kind: "blocked", message: attempt(base).message ?? "An add-on action is pending." };
  if (!review.current() || getGatewayApiBaseUrl() !== base)
    return { kind: "cancelled", message: "Review the current installation before continuing." };
  const pending: Attempt = { phase: "pending" };
  setAttempt(base, pending);
  let dispatched = false;
  const requireInstallation = () => {
    if (getGatewayApiBaseUrl() !== base)
      throw new Error("Gateway installation changed; the original action cannot be verified here.");
  };
  const readStatus = async () => {
    requireInstallation();
    const value = await fetchAddonStatus(addonId);
    requireInstallation();
    assertAddonStatus(value, addonId);
    return value;
  };
  try {
    assertAddonStatus(before, addonId);
    const fresh = await readStatus();
    if (!review.current()) return { kind: "cancelled", message: "The add-on review changed before dispatch." };
    if (!addonRecordsEqual(before, fresh) || !addonActionAvailable(action, fresh))
      return {
        kind: "blocked",
        message: "The add-on changed or this action is unavailable. Refresh and review its current owner record.",
      };
    requireInstallation();
    if (!review.current()) return { kind: "cancelled", message: "The add-on review changed before dispatch." };
    dispatched = true;
    if (action === "uninstall") {
      const receipt = await uninstallAddon(addonId);
      requireInstallation();
      if (receipt.addonId !== addonId || receipt.removed !== true)
        throw new Error("Uninstall receipt does not match the reviewed add-on.");
      const status = await readStatus();
      const installed = await fetchInstalledAddons();
      requireInstallation();
      if (
        status.installed ||
        status.status !== "not_installed" ||
        !addonRecordsEqual(status.addon, before.addon) ||
        installed.items.some((item) => item.addonId === addonId)
      )
        throw new Error("Add-on removal could not be independently verified.");
      return { kind: "confirmed", status };
    }
    const receipt = await dispatchAddon(action, addonId);
    requireInstallation();
    assertAddonReceipt(action, before, receipt.status);
    const saved = await readStatus();
    if (!addonRecordsEqual(saved, receipt.status)) throw new Error("Add-on readback differs from the action receipt.");
    return { kind: "confirmed", status: saved };
  } catch (error) {
    if (dispatched) {
      const message =
        "The add-on action outcome is uncertain. Further add-on writes to this installation are locked in both shells for this app session. Inspect Gateway records and host processes before continuing.";
      setAttempt(base, { phase: "uncertain", message });
      return { kind: "uncertain", message };
    }
    return {
      kind: "blocked",
      message: error instanceof Error ? error.message : "Add-on owner evidence is unavailable.",
    };
  } finally {
    if (attempt(base) === pending) setAttempt(base, IDLE);
  }
}
function dispatchAddon(action: Exclude<AddonAction, "uninstall">, id: string) {
  switch (action) {
    case "install":
      return installAddon(id, { confirmRepoDownload: true, actorId: "operator" });
    case "update":
      return updateAddon(id);
    case "enable":
      return enableAddon(id);
    case "disable":
      return disableAddon(id);
    case "launch":
      return launchAddon(id);
    case "stop":
      return stopAddon(id);
  }
}
export function __resetAddonAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
