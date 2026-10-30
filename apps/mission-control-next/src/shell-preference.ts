/** A presentation preference only; Gateway state and authority are unaffected. */
export const SHELL_PREFERENCE_KEY = "goatcitadel.ui.shell.v1";
export type ShellPreference = "classic" | "cockpit";

function parseShell(value: string | null | undefined): ShellPreference | null {
  return value === "classic" || value === "cockpit" ? value : null;
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function writeShellPreference(
  shell: ShellPreference,
  storage: Pick<Storage, "setItem"> | null = localStorageOrNull(),
): void {
  try {
    storage?.setItem(SHELL_PREFERENCE_KEY, shell);
  } catch {
    // Fall back to the URL override when browser storage is unavailable.
  }
}

export function resolveShellPreference(input: {
  search: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): ShellPreference {
  const override = parseShell(new URLSearchParams(input.search).get("shell"));
  if (override) {
    if (new URLSearchParams(input.search).get("shellScope") !== "visit") writeShellPreference(override, input.storage);
    return override;
  }
  try {
    return parseShell(input.storage?.getItem(SHELL_PREFERENCE_KEY)) ?? "cockpit";
  } catch {
    return "cockpit";
  }
}

export function buildShellSwitchUrl(href: string, shell: ShellPreference, sessionId?: string | null): string {
  const next = new URL(href);
  next.searchParams.delete("shellScope");
  if (shell === "classic") {
    // The same Classic Costs owner backs both native views; retain only the explicit overview return.
    if (next.pathname === "/system/spend") next.searchParams.set("cockpitReturnView", "spend-overview");
    else if (
      next.pathname === "/system/spend/details" &&
      next.searchParams.getAll("cockpitReturnView").length === 1 &&
      next.searchParams.getAll("cockpitReturnView")[0] === "spend-overview"
    )
      next.searchParams.delete("cockpitReturnView");
    // The fallback may carry the query its Classic owner needs (for example `?view=browser-sessions`).
    const fallback = new URL(classicFallbackPath(next.pathname), next.origin);
    next.pathname = fallback.pathname;
    fallback.searchParams.forEach((value, key) => next.searchParams.set(key, value));
  }
  if (sessionId !== undefined) {
    if (sessionId) next.searchParams.set("sessionId", sessionId);
    else next.searchParams.delete("sessionId");
  }
  // Keep an explicit override so the switch works even when storage is blocked.
  next.searchParams.set("shell", shell);
  return next.toString();
}

export async function switchShell(
  shell: ShellPreference,
  options: {
    sessionId?: string | null;
    href?: string;
    isCurrent: () => boolean;
    signal?: AbortSignal;
  },
): Promise<"opened" | "cancelled"> {
  const origin = window.location.href;
  const target = options.href ?? buildShellSwitchUrl(origin, shell, options.sessionId);
  const { openApplicationShell } = await import("./app/shell-transition");
  if (window.location.href !== origin || !options.isCurrent() || options.signal?.aborted) return "cancelled";
  return openApplicationShell(shell, target, options);
}

/** The Classic owner of each ported System view; every other System view rolls back to the runtime page. */
const classicSystemViews: Record<string, string> = {
  activity: "/ops/activity",
  quality: "/ops/quality",
  diagnostics: "/ops/diagnostics",
  improvement: "/ops/improvement",
  spend: "/ops/costs",
  dashboards: "/ops/boards",
  "browser-sessions": "/ops/sessions?view=browser-sessions",
};

function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Cockpit-only routes return to the nearest Classic surface during rollback. The result is a path that may
 * carry the query its Classic owner needs; `resolveCockpitCompatibility` maps each one back to the same
 * Cockpit view (see the round-trip test).
 */
export function classicFallbackPath(pathname: string): string {
  const [, segment, detail, record] = pathname.split("/");
  if (segment === "inbox") return "/ops/approvals";
  if (segment === "work") return detail === "schedules" ? "/ops/schedules" : "/ops/kanban";
  if (pathname === "/system/runtime/workers") return "/ops/workers";
  if (segment === "system") return (detail && classicSystemViews[detail]) || "/ops/runtime";
  if (segment === "chat" && detail === "projects") {
    const projectId = record ? decodedSegment(record) : null;
    return projectId ? `/projects?${new URLSearchParams({ projectId })}` : "/projects";
  }
  if (segment === "settings") {
    const cockpitOnlySettings: Record<string, string> = {
      models: "/settings/onboarding",
      connections: "/settings/channels",
      safety: "/settings/permissions",
      citadel: "/library/citadel-overview",
      advanced: "/settings/runtime",
      "first-run": "/settings/onboarding",
    };
    if (detail && cockpitOnlySettings[detail]) return cockpitOnlySettings[detail];
  }
  // Advanced setup and Advanced channel setup took over Settings › Connections, which Classic still has.
  if (pathname === "/capabilities/connectors/advanced") return "/settings/mcp";
  if (pathname === "/chat/messaging/advanced") return "/settings/channels";
  if (segment === "__gallery") return "/settings/general";
  return pathname;
}
