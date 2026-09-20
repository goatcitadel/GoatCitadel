import { Download } from "lucide-react";
import { useDesktopUpdates } from "./desktop-update-bridge";

export function DesktopUpdateBadge() {
  const status = useDesktopUpdates();
  if (!status?.availableRelease) return null;
  return (
    <a
      className="mc-next-status-pill"
      href="/settings/general#updates"
      aria-label={`Update available: ${status.availableRelease.version}`}
    >
      <Download size={14} aria-hidden="true" />
      <span>Update available</span>
    </a>
  );
}
