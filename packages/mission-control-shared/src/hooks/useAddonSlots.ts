import { useCallback, useEffect, useState } from "react";
import type { AddonDashboardSlot } from "@goatcitadel/contracts";
import { fetchAddonSlots, type AddonSlotRegistration } from "../api/platform.js";

export interface UseAddonSlotsOptions {
  enabled?: boolean;
}

export interface UseAddonSlotsResult {
  items: AddonSlotRegistration[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAddonSlots(
  route?: string,
  slot?: AddonDashboardSlot,
  options: UseAddonSlotsOptions = {},
): UseAddonSlotsResult {
  const [items, setItems] = useState<AddonSlotRegistration[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = options.enabled ?? true;

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetchAddonSlots({ route, slot });
      setItems(response.items);
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [enabled, route, slot]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { items, loading, error, refresh };
}
