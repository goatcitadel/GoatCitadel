import { useCallback, useEffect, useRef, useState } from "react";
import type { AddonStatusRecord } from "@goatcitadel/contracts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  fetchAddonsCatalog,
  fetchAddonStatus,
  fetchInstalledAddons,
} from "@goatcitadel/mission-control-shared/api/client";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { useAsyncLoad, type Notice } from "../SettingsShared";
import { addonActionAvailable, assertAddonStatus, type AddonAction } from "./addon-owner-binding";
import { commitAddonReview, useAddonMutation, type AddonReview } from "./addon-lifecycle";

export function useAddonSettings() {
  const base = getGatewayApiBaseUrl(),
    mutation = useAddonMutation(base);
  const [selectedAddonId, setSelectedId] = useSessionViewState(`addons:${base}:selected`, "");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [review, setReview] = useState<AddonReview | null>(null),
    reviewRef = useRef<AddonReview | null>(null);
  const [status, setStatus] = useState<{
    base: string;
    id: string;
    loading: boolean;
    error?: string;
    data?: AddonStatusRecord;
  }>({ base, id: "", loading: false });
  const statusReadGeneration = useRef(0);
  const generation = useRef({ identity: "", mounted: true });
  const identity = JSON.stringify([base, selectedAddonId]);
  if (generation.current.identity !== identity) generation.current = { identity, mounted: true };
  const captured = generation.current;
  useEffect(() => {
    generation.current.mounted = true;
    return () => {
      generation.current.mounted = false;
    };
  }, []);
  const current = () => captured === generation.current && captured.mounted && getGatewayApiBaseUrl() === base;
  const cancelReview = () => {
    reviewRef.current = null;
    setReview(null);
  };
  const invalidate = () => {
    generation.current = { identity, mounted: true };
    cancelReview();
  };
  const load = useCallback(async () => {
    const [catalog, installed] = await Promise.all([fetchAddonsCatalog(), fetchInstalledAddons()]);
    if (
      catalog.items.length > 500 ||
      installed.items.length > 500 ||
      new Set(catalog.items.map((item) => item.addonId)).size !== catalog.items.length ||
      new Set(installed.items.map((item) => item.addonId)).size !== installed.items.length
    )
      throw new Error("Add-on evidence is too large or contains duplicate identities.");
    return { base, catalog: catalog.items, installed: installed.items };
  }, [base]);
  const loaded = useAsyncLoad(load, [load]);
  const data = loaded.data?.base === base ? loaded.data : null;
  useEffect(() => {
    let cancelled = false;
    const readGeneration = ++statusReadGeneration.current;
    setStatus({ base, id: selectedAddonId, loading: Boolean(selectedAddonId) });
    if (selectedAddonId)
      void fetchAddonStatus(selectedAddonId)
        .then((value) => {
          assertAddonStatus(value, selectedAddonId);
          if (!cancelled && readGeneration === statusReadGeneration.current)
            setStatus({ base, id: selectedAddonId, loading: false, data: value });
        })
        .catch((error: unknown) => {
          if (!cancelled && readGeneration === statusReadGeneration.current)
            setStatus({
              base,
              id: selectedAddonId,
              loading: false,
              error: error instanceof Error ? error.message : "Status unavailable.",
            });
        });
    return () => {
      cancelled = true;
    };
  }, [base, selectedAddonId]);
  const selectedStatus = status.base === base && status.id === selectedAddonId ? status.data : undefined;
  function selectAddon(id: string) {
    invalidate();
    setSelectedId(id);
    setNotice(null);
  }
  async function reload() {
    invalidate();
    const scope = generation.current;
    const readGeneration = ++statusReadGeneration.current;
    await loaded.reload();
    if (!selectedAddonId || generation.current !== scope || !scope.mounted || getGatewayApiBaseUrl() !== base) return;
    try {
      const value = await fetchAddonStatus(selectedAddonId);
      assertAddonStatus(value, selectedAddonId);
      if (
        readGeneration === statusReadGeneration.current &&
        generation.current === scope &&
        scope.mounted &&
        getGatewayApiBaseUrl() === base
      )
        setStatus({ base, id: selectedAddonId, loading: false, data: value });
    } catch (error) {
      if (
        readGeneration === statusReadGeneration.current &&
        generation.current === scope &&
        scope.mounted &&
        getGatewayApiBaseUrl() === base
      )
        setStatus({
          base,
          id: selectedAddonId,
          loading: false,
          error: error instanceof Error ? error.message : "Status unavailable.",
        });
    }
  }
  function reviewAction(action: AddonAction) {
    if (!current() || mutation.locked || !selectedStatus || !addonActionAvailable(action, selectedStatus)) return;
    const next: AddonReview = {
      action,
      status: structuredClone(selectedStatus),
      base,
      current: () => current() && reviewRef.current === next,
    };
    reviewRef.current = next;
    setReview(next);
    setNotice(null);
  }
  async function confirmReview() {
    const reviewed = reviewRef.current;
    if (!reviewed?.current()) return;
    const result = await commitAddonReview(reviewed);
    if (!reviewed.current()) return;
    cancelReview();
    if (result.kind === "confirmed") {
      statusReadGeneration.current += 1;
      setStatus({ base, id: selectedAddonId, loading: false, data: result.status });
      setNotice({
        tone: result.status.status === "error" ? "warning" : "success",
        message:
          result.status.status === "error"
            ? "The Gateway recorded an add-on error. Inspect its health and error evidence; the application is not confirmed healthy."
            : `Add-on ${reviewed.action} confirmed by the Gateway receipt and independent readback.`,
      });
      // Loading the catalog is presentation refresh; a later read failure cannot unsettle the verified action.
      try {
        await loaded.reload();
      } catch {
        /* The loader exposes current read failures. */
      }
    } else setNotice({ tone: result.kind === "uncertain" ? "warning" : "error", message: result.message });
  }
  return {
    ...loaded,
    data,
    reload,
    selectedAddonId,
    selectAddon,
    selectedStatus,
    statusLoading: status.base === base && status.id === selectedAddonId && status.loading,
    statusError: status.base === base && status.id === selectedAddonId ? status.error : undefined,
    notice,
    mutation,
    review: review?.current() ? review : null,
    reviewAction,
    confirmReview,
    cancelReview,
  };
}
export type AddonSettingsOwner = ReturnType<typeof useAddonSettings>;
