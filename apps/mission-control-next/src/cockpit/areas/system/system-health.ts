import type { DesktopUpdateStatus } from "@goatcitadel/contracts";
import type { BackupTrustState } from "./backup-trust";
import type { HealthCheck } from "./health-overview";
import { backupHealthCheck, deriveHealthChecks } from "./health-overview";
import type { SystemHealthSources } from "./system-health-sources";

function unknown(id: HealthCheck["id"], title: string, detail: string, inspectPath: string): HealthCheck {
  return { id, title, detail, inspectPath, status: { label: "Unknown", tone: "neutral" } };
}

/** Known to be off. Labelled plainly and kept out of the "lack live proof" summary. */
function notSetUp(
  id: HealthCheck["id"],
  title: string,
  detail: string,
  inspectPath: string,
  label = "Not set up",
): HealthCheck {
  return { id, title, detail, inspectPath, notSetUp: true, status: { label, tone: "neutral" } };
}

export function deriveSystemHealthChecks(
  sources: SystemHealthSources,
  updates: DesktopUpdateStatus | null,
  backupTrust?: BackupTrustState,
): HealthCheck[] {
  const base =
    sources.summary.state === "current"
      ? deriveHealthChecks(sources.summary.value, backupTrust)
      : [
          unknown("gateway", "Gateway", "The health summary could not be read.", "/ops/runtime"),
          unknown(
            "database",
            "Database",
            "Database health could not be checked without the Gateway summary.",
            "/ops/runtime",
          ),
          unknown(
            "service",
            "Runtime service",
            "Service status could not be checked without the Gateway summary.",
            "/ops/runtime",
          ),
          backupTrust && backupTrust !== "unknown"
            ? backupHealthCheck(backupTrust, false)
            : unknown("backups", "Backups", "Backup verification status could not be checked.", "/ops/runtime"),
        ];

  const models = (() => {
    if (sources.llama.state === "unavailable" || sources.npu.state === "unavailable")
      return unknown(
        "models",
        "Managed local models",
        "At least one managed runtime status could not be read. Cloud provider health is separate.",
        "/settings/local-ai",
      );
    const enabled = [sources.llama.value, sources.npu.value].filter((runtime) => runtime.enabled);
    if (!enabled.length)
      return notSetUp(
        "models",
        "Managed local models",
        "No managed local runtime is enabled. Cloud provider health is separate.",
        "/settings/local-ai",
      );
    const unhealthy = enabled.filter((runtime) => runtime.processState === "error" || !runtime.healthy);
    return {
      id: "models",
      title: "Managed local models",
      inspectPath: "/settings/local-ai",
      detail: unhealthy.length
        ? `${unhealthy.length} enabled local ${unhealthy.length === 1 ? "runtime needs" : "runtimes need"} review.`
        : `${enabled.length} enabled managed local ${enabled.length === 1 ? "runtime reports" : "runtimes report"} healthy. Cloud providers are separate.`,
      status: unhealthy.length
        ? { label: "Needs review", tone: "failed" }
        : { label: "Reported healthy", tone: "done" },
    } satisfies HealthCheck;
  })();

  const channels = (() => {
    if (sources.channels.state === "unavailable")
      return unknown("channels", "Channels", "Channel runtime status could not be read.", "/settings/channels");
    const { enabledCount, checked } = sources.channels.value;
    if (!enabledCount)
      return notSetUp("channels", "Channels", "No channel connection is enabled.", "/settings/channels");
    const ready = checked.filter((entry) => entry.runtime.state === "current" && entry.runtime.value.ready).length;
    const notReady = checked.filter((entry) => entry.runtime.state === "current" && !entry.runtime.value.ready).length;
    const missing = enabledCount - ready - notReady;
    if (notReady)
      return {
        id: "channels",
        title: "Channels",
        inspectPath: "/settings/channels",
        detail: `${notReady} enabled ${notReady === 1 ? "channel is" : "channels are"} not ready${missing ? `; ${missing} more could not be checked` : ""}.`,
        status: { label: "Needs review", tone: "waiting" },
      } satisfies HealthCheck;
    if (missing)
      return unknown(
        "channels",
        "Channels",
        `${ready} of ${enabledCount} enabled channel runtimes reported ready; the rest could not be checked.`,
        "/settings/channels",
      );
    return {
      id: "channels",
      title: "Channels",
      inspectPath: "/settings/channels",
      detail: `${enabledCount} enabled channel ${enabledCount === 1 ? "runtime reports" : "runtimes report"} ready.`,
      status: { label: "Ready", tone: "done" },
    } satisfies HealthCheck;
  })();

  const integrations = (() => {
    if (sources.connections.state === "unavailable")
      return unknown(
        "integrations",
        "Integrations",
        "Connection records could not be listed.",
        "/settings/integrations",
      );
    const enabled = sources.connections.value.filter(
      (connection) => connection.enabled && connection.kind !== "channel",
    );
    if (!enabled.length)
      return notSetUp(
        "integrations",
        "Integrations",
        "No non-channel integration connection is enabled.",
        "/settings/integrations",
      );
    const errors = enabled.filter((connection) => connection.status === "error").length;
    const disconnected = enabled.filter((connection) => connection.status === "disconnected").length;
    if (errors || disconnected)
      return {
        id: "integrations",
        title: "Integrations",
        inspectPath: "/settings/integrations",
        detail: `${errors} connection errors and ${disconnected} disconnected connections were recorded.`,
        status: { label: "Needs review", tone: errors ? "failed" : "waiting" },
      } satisfies HealthCheck;
    return unknown(
      "integrations",
      "Integrations",
      `${enabled.length} enabled connection records have no error status. Live diagnostics were not run.`,
      "/settings/integrations",
    );
  })();

  const workers = (() => {
    if (sources.workers.state === "unavailable")
      return unknown(
        "remote_workers",
        "Remote workers",
        "The scoped worker registry could not be read.",
        "/ops/runtime",
      );
    const registry = sources.workers.value;
    const quarantined = registry.items.filter((item) => item.posture.value === "quarantined").length;
    if (quarantined)
      return {
        id: "remote_workers",
        title: "Remote workers",
        inspectPath: "/ops/runtime",
        detail: `${quarantined} ${quarantined === 1 ? "worker is" : "workers are"} quarantined. Connection health is not supplied by this registry.`,
        status: { label: "Needs review", tone: "waiting" },
      } satisfies HealthCheck;
    if (!registry.items.length)
      return notSetUp("remote_workers", "Remote workers", "No worker is registered in this workspace.", "/ops/runtime");
    return unknown(
      "remote_workers",
      "Remote workers",
      `${registry.items.length}${registry.nextCursor ? "+" : ""} worker records are visible. Connection health is not supplied by this registry.`,
      "/ops/runtime",
    );
  })();

  const updateCheck: HealthCheck = !updates
    ? notSetUp(
        "updates",
        "Desktop updates",
        "Update status is available in the installed Windows app.",
        "/settings/general#updates",
        "Desktop app only",
      )
    : updates.phase === "error"
      ? {
          id: "updates",
          title: "Desktop updates",
          inspectPath: "/settings/general#updates",
          detail: "The last update check or operation reported an error.",
          status: { label: "Needs review", tone: "waiting" },
        }
      : updates.availableRelease
        ? {
            id: "updates",
            title: "Desktop updates",
            inspectPath: "/settings/general#updates",
            detail: "An update is available for operator review and installation.",
            status: { label: "Update available", tone: "waiting" },
          }
        : updates.lastSuccessfulCheck
          ? {
              id: "updates",
              title: "Desktop updates",
              inspectPath: "/settings/general#updates",
              detail: "No eligible update was reported at the last successful check.",
              status: { label: "Checked", tone: "done" },
            }
          : unknown(
              "updates",
              "Desktop updates",
              "The installed app has not reported a successful update check.",
              "/settings/general#updates",
            );

  return [...base, models, channels, integrations, updateCheck, workers];
}
