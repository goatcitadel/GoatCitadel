import type { CapabilityKind } from "@goatcitadel/contracts";
import { readCatalogLocation } from "../areas/library/capability-catalog-route";
import { adaptLegacyUrl } from "../../app/legacy-route-adapter";
import { buildAppHref, parseAppRoute, RAIL_ITEMS } from "../../app/route-model";
import { buildSettingsDestinations } from "../areas/settings/settings-destinations";
import { parseCockpitLocation } from "./routes";

export type CockpitResolution =
  | { kind: "native"; href: string }
  | { kind: "classic"; href: string; label: string }
  | { kind: "missing" };

const systemViews = new Set([
  "health",
  "spend",
  "quality",
  "diagnostics",
  "activity",
  "sessions",
  "dashboards",
  "browser-sessions",
  "improvement",
  "runtime",
]);
const libraryViews = new Set([
  "capabilities",
  "memory",
  "notes",
  "files",
  "artifacts",
  "agents",
  "knowledge",
  "communications",
  "curator",
  "journey",
  "prompt-packs",
  "citadel",
  "citadel-overview",
  "citadel-blueprint",
  "citadel-wards",
  "citadel-council",
  "citadel-vault",
]);
const catalogKinds: Record<CapabilityKind, true> = {
  tool: true,
  skill: true,
  code_mode: true,
  proposal: true,
  candidate_skill: true,
  mesh_tool: true,
  mesh_mcp_server: true,
  mesh_skill: true,
};
const settings = buildSettingsDestinations();
const opsNative: Record<string, string> = {
  approvals: "/inbox",
  activity: "/system/activity",
  quality: "/system/quality",
  diagnostics: "/system/runtime/diagnostics",
  costs: "/system/spend/details",
  improvement: "/system/improvement",
  // Runtime reuses its existing Services, efficiency, backup and diagnostics owners inside Cockpit.
  // Worker status remains an inspection boundary; desktop notifications land in Inbox.
  runtime: "/system/runtime",
  workers: "/system/runtime/workers",
  notifications: "/inbox",
  // These destinations reuse the existing session evidence and revision-aware task owners.
  sessions: "/system/sessions",
  kanban: "/work/kanban",
  boards: "/system/dashboards",
  schedules: "/work/schedules",
};
/** Legacy Cowork board and task inputs normalize to the Work board (`/cowork` itself normalizes to Chat). */
const coworkWorkViews = new Set(["board", "tasks"]);

/** Conversation publication follows route coverage, including root/alias entries, but never Projects. */
export function isCockpitConversationLocation(input: string): boolean {
  const resolution = resolveCockpitCompatibility(input);
  if (resolution.kind !== "native") return false;
  const route = parseCockpitLocation(new URL(resolution.href, "http://cockpit.invalid").pathname);
  return route.area === "chat" && route.rest.length === 0;
}

function validApprovalRecordId(value: string): boolean {
  if (!value || value.trim() !== value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}
/** Coverage, not the permissive Classic parser, decides whether a Cockpit view exists. */
export function resolveCockpitCompatibility(input: string): CockpitResolution {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return { kind: "missing" };
  const url = new URL(input, "http://cockpit.invalid");
  const classic = (): CockpitResolution => {
    const fallback = new URL(url);
    fallback.searchParams.set("shell", "classic");
    return { kind: "classic", href: fallback.pathname + fallback.search + fallback.hash, label: "Open in Classic" };
  };
  if (url.searchParams.get("shell") === "classic") return classic();
  if (input.startsWith("/inbox/approvals/") && !url.pathname.startsWith("/inbox/approvals/"))
    return { kind: "missing" };
  // Only root legacy routing parameters are Classic inputs. Native URLs own their query state.
  if (url.pathname === "/" && ["tab", "space", "page", "surface"].some((key) => url.searchParams.has(key))) {
    const route = adaptLegacyUrl(url);
    if (!route) return { kind: "missing" };
    if (route.area === "chat") {
      const tab = url.searchParams.get("tab")?.trim().toLowerCase();
      const surface = url.searchParams.get("surface");
      const knownChat = tab && ["chat", "dashboard", "assembly"].includes(tab);
      const knownSurface =
        !tab &&
        (!surface || ["chat", "cowork", "code"].includes(surface)) &&
        ((url.searchParams.get("space") === "operate" && url.searchParams.get("page") === "surface") ||
          (!url.searchParams.has("space") && !url.searchParams.has("page") && Boolean(surface)));
      if (!knownChat && !knownSurface) return { kind: "missing" };
    }
    const canonical = new URL(buildAppHref(route), url);
    url.pathname = canonical.pathname;
    for (const key of ["tab", "space", "page", "surface"]) url.searchParams.delete(key);
    canonical.searchParams.forEach((value, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [area, section] = parts;
  const native = (path?: string): CockpitResolution => {
    if (path) url.pathname = path;
    return { kind: "native", href: url.pathname + url.search + url.hash };
  };
  if (
    area === "settings" &&
    section === "onboarding" &&
    parts.length === 2 &&
    url.searchParams.get("view") === "llamacpp"
  ) {
    url.hash = "local-ai";
    return native("/settings/models");
  }
  if (!area || (area === "chat" && parts.length === 1)) return native();
  if ((area === "cowork" || area === "code") && parts.length === 1) {
    const route = parseAppRoute(url);
    return native(new URL(buildAppHref(route), url).pathname);
  }
  if (area === "cowork" && parts.length === 2 && coworkWorkViews.has(section!)) return native("/work");
  let linkedApprovalId: string | undefined;
  if (area === "inbox" && section === "approvals" && parts.length === 3) {
    if (url.pathname !== "/inbox/approvals/" + parts[2]) return { kind: "missing" };
    try {
      linkedApprovalId = decodeURIComponent(parts[2]!);
    } catch {
      return { kind: "missing" };
    }
  }
  if (
    (area === "inbox" && parts.length === 1) ||
    (area === "ops" && section === "approvals" && parts.length === 2) ||
    linkedApprovalId !== undefined
  ) {
    const approvalIds = url.searchParams.getAll("approvalId");
    const approvalId = linkedApprovalId ?? approvalIds[0];
    if (approvalId !== undefined && (!validApprovalRecordId(approvalId) || approvalIds.some((id) => id !== approvalId)))
      return { kind: "missing" };
    if (linkedApprovalId !== undefined) url.searchParams.set("approvalId", linkedApprovalId);
    const view = url.searchParams.get("view");
    const historyView = url.searchParams.get("historyView");
    if (
      (view && !["pending", "history", "all", "recovery", "approved", "rejected", "edited"].includes(view)) ||
      (historyView && !["pending", "all", "recovery", "approved", "rejected", "edited"].includes(historyView))
    )
      return { kind: "missing" };
    return native("/inbox");
  }
  if (area === "__gallery" && parts.length === 1) return native();
  if (area === "system" && (parts.length === 1 || (parts.length === 2 && systemViews.has(section!)))) return native();
  if (area === "system" && section === "spend" && parts.length === 3 && parts[2] === "details") return native();
  if (area === "system" && section === "dashboards" && parts.length === 3) return native();
  if (
    area === "system" &&
    section === "runtime" &&
    parts.length === 3 &&
    ["diagnostics", "workers"].includes(parts[2]!)
  )
    return native();
  if (
    area === "work" &&
    (parts.length === 1 ||
      (parts.length === 2 && ["board", "history", "schedules", "kanban", "archive", "automation"].includes(section!)) ||
      (parts.length === 3 && ["tasks", "runs"].includes(section!)))
  )
    return native();
  if (area === "library") {
    // Notes are UUID-owned records. Keep malformed resource suffixes unavailable.
    if (
      section === "notes" &&
      parts.length === 3 &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(parts[2]!)
    ) {
      url.searchParams.set("noteId", parts[2]!);
      return native("/library/notes");
    }
    if (parts.length === 1 || (parts.length === 2 && libraryViews.has(section!))) return native();
    const catalog = readCatalogLocation(parts.slice(1), url.search);
    if (
      !catalog.invalidSelection &&
      (catalog.selection
        ? Object.hasOwn(catalogKinds, catalog.selection.kind)
        : section === "skills" || section === "tools")
    )
      return native();
  }
  if (
    area === "settings" &&
    (parts.length === 1 ||
      (parts.length === 2 &&
        (section === "first-run" ||
          settings.some(
            (page) =>
              page.id === section ||
              page.entries.some((entry) => entry.section === section && entry.destination === "cockpit"),
          ))))
  )
    return native();
  // Browser sessions keep their separate grant and state owner.
  if (
    area === "ops" &&
    section === "sessions" &&
    parts.length === 2 &&
    url.searchParams.get("view") === "browser-sessions"
  ) {
    url.searchParams.delete("view");
    return native("/system/browser-sessions");
  }
  // Only an explicit overview rollback marker selects this fixed native view. Legacy Costs keeps its full owner.
  const returnViews = url.searchParams.getAll("cockpitReturnView");
  if (url.pathname === "/ops/costs" && returnViews.length === 1 && returnViews[0] === "spend-overview") {
    url.searchParams.delete("cockpitReturnView");
    return native("/system/spend");
  }
  // A run link (Inbox run recovery, delegated runs) opens that run in Work; a runtime section anchor stays in System.
  const runId = url.searchParams.get("runId");
  if (
    area === "ops" &&
    section === "runtime" &&
    parts.length === 2 &&
    runId &&
    !url.hash &&
    validApprovalRecordId(runId)
  ) {
    url.searchParams.delete("runId");
    return native(`/work/runs/${encodeURIComponent(runId)}`);
  }
  if (area === "ops" && parts.length === 2 && section && opsNative[section]) {
    return native(opsNative[section]);
  }
  if (area === "chat" && section === "projects" && parts.length <= 3) return native();
  if (area === "projects" && parts.length <= 2)
    return native(
      `/chat/projects${section ? `/${section}` : url.searchParams.get("projectId") ? `/${encodeURIComponent(url.searchParams.get("projectId")!)}` : ""}`,
    );
  if (
    (area === "ops" || area === "library" || area === "settings") &&
    parts.length <= 2 &&
    (!section || RAIL_ITEMS[area].some((item) => item.section === section))
  )
    return classic();
  return { kind: "missing" };
}

/** Internal owner projections are continuations, not an operator's explicit layout choice.
 * Caller/record authority remains with the destination; navigation alone cannot approve an action.
 */
export function resolveCockpitContinuation(
  input: string,
  context: { search?: string; hash?: string; workspaceId?: string } = {},
): CockpitResolution {
  if (!input.startsWith("/") || input.startsWith("//") || /[\\\r\n]/u.test(input)) return { kind: "missing" };
  try {
    const url = new URL(input, "http://cockpit.invalid");
    const rawPath = input.split(/[?#]/u, 1)[0]!;
    if (url.origin !== "http://cockpit.invalid" || url.pathname !== rawPath) return { kind: "missing" };
    const carried = new URLSearchParams(context.search);
    for (const key of new Set(carried.keys())) {
      if (key === "shell" || key === "shellScope" || url.searchParams.has(key)) continue;
      for (const value of carried.getAll(key)) url.searchParams.append(key, value);
    }
    if (context.workspaceId !== undefined) {
      if (!context.workspaceId) return { kind: "missing" };
      url.searchParams.set("workspaceId", context.workspaceId);
    }
    if (!input.includes("#") && context.hash) url.hash = context.hash;
    url.searchParams.set("shell", "cockpit");
    url.searchParams.delete("shellScope");
    return resolveCockpitCompatibility(rawPath + url.search + url.hash);
  } catch {
    return { kind: "missing" };
  }
}
