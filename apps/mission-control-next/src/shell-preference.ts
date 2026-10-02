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
    writeShellPreference(override, input.storage);
    return override;
  }
  try {
    return parseShell(input.storage?.getItem(SHELL_PREFERENCE_KEY)) ?? "classic";
  } catch {
    return "classic";
  }
}

export function buildShellSwitchUrl(href: string, shell: ShellPreference, sessionId?: string | null): string {
  const next = new URL(href);
  if (shell === "classic") next.pathname = classicFallbackPath(next.pathname);
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

/** Routes owned only by the preview should return to the nearest current surface. */
export function classicFallbackPath(pathname: string): string {
  const [, segment, detail] = pathname.split("/");
  if (segment === "inbox") return "/ops/approvals";
  if (segment === "work") return "/ops/kanban";
  if (segment === "system") return detail === "spend" ? "/ops/costs" : "/ops/runtime";
  if (segment === "settings") {
    const previewOnlySettings: Record<string, string> = {
      models: "/settings/onboarding",
      connections: "/settings/channels",
      safety: "/settings/permissions",
      citadel: "/library/citadel-overview",
      advanced: "/settings/runtime",
      "first-run": "/settings/onboarding",
    };
    if (detail && previewOnlySettings[detail]) return previewOnlySettings[detail];
  }
  if (segment === "__gallery") return "/settings/general";
  return pathname;
}
