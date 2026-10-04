import { flushSync } from "react-dom";
import { captureApplicationRoot, isApplicationRootCurrent } from "./application-root";
import { writeShellPreference, type ShellPreference } from "../shell-preference";

export const SHELL_NAVIGATION_EVENTS = [
  "popstate",
  "hashchange",
  "goatcitadel:cockpit-location",
  "goatcitadel:classic-location",
] as const;
/** Both shells number their history entries under this key, so one sequence survives a shell switch. */
export const SHELL_HISTORY_POSITION = "goatcitadelNavigationPosition";
export interface ShellTransitionOptions {
  /** The initiating view owns scope, draft-leave review, and lifetime. */
  isCurrent: () => boolean;
  signal?: AbortSignal;
}
let latestAttempt = 0;
let classicEntry: Promise<typeof import("../classic-entry")> | undefined;
let cockpitEntry: Promise<typeof import("../cockpit-entry")> | undefined;
async function loadEntry(shell: ShellPreference): Promise<(root: HTMLElement) => void> {
  if (shell === "classic") {
    classicEntry ??= import("../classic-entry").catch((error: unknown) => {
      classicEntry = undefined;
      throw error;
    });
    return (await classicEntry).mountClassic;
  }
  cockpitEntry ??= import("../cockpit-entry").catch((error: unknown) => {
    cockpitEntry = undefined;
    throw error;
  });
  return (await cockpitEntry).mountCockpit;
}
/**
 * Explicit shell handoff, not a history router. Reuse the existing React root
 * and replace only this entry; each shell retains its own navigation adapters.
 * Module-scoped drafts and mutation admission stores therefore survive.
 */
export async function openApplicationShell(
  shell: ShellPreference,
  href: string,
  options: ShellTransitionOptions,
): Promise<"opened" | "cancelled"> {
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin || target.username || target.password) {
    throw new Error("A shell owner must be opened within this application.");
  }
  target.searchParams.set("shell", shell);
  const container = document.getElementById("root");
  const token = container ? captureApplicationRoot(container) : undefined;
  if (!container || !token) throw new Error("The application root is unavailable.");
  const origin = window.location.href;
  const source = document.documentElement.dataset.shell;
  const attempt = ++latestAttempt;
  let navigationChanged = false;
  const cancelForNavigation = () => {
    navigationChanged = true;
  };
  const current = () =>
    !navigationChanged &&
    latestAttempt === attempt &&
    !options.signal?.aborted &&
    options.isCurrent() &&
    window.location.href === origin &&
    (source === "cockpit" || source === "classic") &&
    source !== shell &&
    document.documentElement.dataset.shell === source &&
    container.isConnected &&
    document.getElementById("root") === container &&
    isApplicationRootCurrent(container, token);
  if (!current()) return "cancelled";
  for (const event of SHELL_NAVIGATION_EVENTS) window.addEventListener(event, cancelForNavigation);
  try {
    const mount = await loadEntry(shell);
    if (!current()) return "cancelled";
    window.history.replaceState(window.history.state, "", target.pathname + target.search + target.hash);
    document.documentElement.dataset.shell = shell;
    flushSync(() => mount(container));
    if (target.searchParams.get("shellScope") !== "visit") writeShellPreference(shell);
    return "opened";
  } finally {
    for (const event of SHELL_NAVIGATION_EVENTS) window.removeEventListener(event, cancelForNavigation);
  }
}
