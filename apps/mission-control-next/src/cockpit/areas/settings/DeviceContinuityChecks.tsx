import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import { deriveDesktopMobileContinuityItems } from "../../../features/native-routes/settings/helpers/provider-format";

function Checks() {
  const settings = useQuery({ queryKey: ["settings", "continuity", "settings"], queryFn: fetchSettings });
  const grants = useQuery({ queryKey: ["settings", "device-grants"], queryFn: () => fetchDeviceAccessGrants("all") });
  const daemon = useQuery({ queryKey: ["settings", "daemon-diagnostics"], queryFn: fetchDaemonStatus });
  if (settings.isError || grants.isError || (grants.data && !Array.isArray(grants.data.items)))
    return (
      <p role="alert" className="text-sm text-status-failed">
        Continuity checks need the Gateway settings and device grants, which could not be read.
      </p>
    );
  if (!settings.data || !grants.data || daemon.isLoading)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Reading continuity evidence…
      </p>
    );
  const items = deriveDesktopMobileContinuityItems({
    settings: settings.data,
    grants: grants.data.items,
    daemon: daemon.isError ? null : (daemon.data ?? null),
  });
  return (
    <ul aria-label="Desktop and mobile continuity checks" className="divide-y divide-line-subtle">
      {items.map((item) => (
        <li key={item.id} className="py-2 text-sm text-fg-secondary">
          <p className="font-medium text-fg">
            {item.label} · {item.actionLabel}
          </p>
          <p className="break-words">{item.description}</p>
          <p className="text-xs text-fg-muted">{item.meta}</p>
        </li>
      ))}
    </ul>
  );
}

/** Read-only desktop/mobile continuity checks. Owner evidence is read only when opened; nothing here acts. */
export function DeviceContinuityChecks() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-4 rounded-lg border border-line bg-sunken p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="min-h-11 cursor-pointer font-display text-base font-semibold text-fg">
        Desktop and mobile continuity
      </summary>
      {open ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-fg-secondary">
            Trusted devices, the desktop runtime, and companion handoff boundaries for this Gateway.
          </p>
          <Checks />
        </div>
      ) : null}
    </details>
  );
}
