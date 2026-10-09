import type { CapabilityKind } from "@goatcitadel/contracts";
import { readCatalogLocation } from "../areas/library/capability-catalog-route";
import { adaptLegacyUrl } from "../../app/legacy-route-adapter";
import { buildAppHref, parseAppRoute, RAIL_ITEMS } from "../../app/route-model";
import { buildSettingsIndex } from "../areas/settings/settings-index";
import { parseCockpitLocation } from "./routes";

export type CockpitResolution =
  | { kind: "native"; href: string }
  | { kind: "classic"; href: string; label: string }
  | { kind: "missing" };

const systemViews = new Set(["health", "spend", "quality", "diagnostics", "activity", "dashboards", "browser-sessions", "improvement"]);
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
const settings = buildSettingsIndex();
const opsNative: Record<string, string> = {
  approvals: "/inbox",
  activity: "/system/activity",
  quality: "/system/quality",
  diagnostics: "/system/diagnostics",
  costs: "/system/spend",
  improvement: "/system/improvement",
  // Port4: saved boards and schedules are native end to end. Kanban stays Classic: agentic run evidence has no
  // native owner yet.
  boards: "/system/dashboards",
  schedules: "/work/schedules",
};

/** Conversation publication follows route coverage, including root/alias entries, but never Projects. */
export function isCockpitConversationLocation(input: string): boolean {
  const resolution = resolveCockpitCompatibility(input);
  if (resolution.kind !== "native") return false;
  const route = parseCockpitLocation(new URL(resolution.href, "http://cockpit.invalid").pathname);
  return route.area === "chat" && route.rest.length === 0;
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
  if (area === "settings" && section === "onboarding" && parts.length === 2 && url.searchParams.get("view") === "llamacpp") {
    url.hash = "local-ai";
    return native("/settings/models");
  }
  if (!area || (area === "chat" && parts.length === 1)) return native();
  if ((area === "cowork" || area === "code") && parts.length === 1) {
    const route = parseAppRoute(url);
    return native(new URL(buildAppHref(route), url).pathname);
  }
  if (area === "inbox" && parts.length === 1) {
    if (url.searchParams.has("view") && url.searchParams.get("view") !== "pending") {
      url.pathname = "/ops/approvals";
      return classic();
    }
    return native();
  }
  if (area === "__gallery" && parts.length === 1) return native();
  if (area === "system" && (parts.length === 1 || (parts.length === 2 && systemViews.has(section!)))) return native();
  if (area === "system" && section === "dashboards" && parts.length === 3) return native();
  if (
    area === "work" &&
    (parts.length === 1 ||
      (parts.length === 2 && ["board", "history", "schedules", "kanban", "archive", "automation"].includes(section!)) ||
      (parts.length === 3 && ["tasks", "runs"].includes(section!)))
  )
    return native();
  if (area === "library") {
    // Notes are UUID-owned records. Keep malformed resource suffixes unavailable.
    if (section === "notes" && parts.length === 3 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(parts[2]!)) {
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
  // Only the browser-session view of Ops sessions is native; run/session evidence stays with Classic.
  if (area === "ops" && section === "sessions" && parts.length === 2 && url.searchParams.get("view") === "browser-sessions") {
    url.searchParams.delete("view");
    return native("/system/browser-sessions");
  }
  if (area === "ops" && parts.length === 2 && section && opsNative[section]) {
    if (section === "approvals" && url.searchParams.has("view") && url.searchParams.get("view") !== "pending")
      return classic();
    return native(opsNative[section]);
  }
  if (area === "chat" && section === "projects" && parts.length <= 3) return native();
  if (area === "projects" && parts.length <= 2) return native(`/chat/projects${section ? `/${section}` : url.searchParams.get("projectId") ? `/${encodeURIComponent(url.searchParams.get("projectId")!)}` : ""}`);
  if (
    (area === "ops" || area === "library" || area === "settings") &&
    parts.length <= 2 &&
    (!section || RAIL_ITEMS[area].some((item) => item.section === section))
  )
    return classic();
  return { kind: "missing" };
}
