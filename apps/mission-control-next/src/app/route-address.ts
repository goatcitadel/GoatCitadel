import { normalizeAppRoute } from "./route-release-kernel";
import type { AppRoute, PrimaryArea } from "./route-model";

export function parseAppRoute(input: string | URL): AppRoute {
  const url = typeof input === "string" ? new URL(input, "http://goatcitadel.local") : input;
  const rawParts = url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.map((part) => part.toLowerCase());
  const params = url.searchParams;
  const area = (parts[0] as PrimaryArea | undefined) ?? "chat";
  const normalizedArea = isPrimaryArea(area) ? area : "chat";
  const routeArea = normalizedArea;
  const routeSection = area === "settings" && parts[1] === "safety" ? "permissions" : parts[1];
  const rawMode = readParam(params, "mode");
  const parsedMode = rawMode === "chat" ? "chat" : undefined;
  const nextRoute: AppRoute = normalizeAppRoute({
    area: routeArea,
    channelPlan: readParam(params, "channelPlan"),
    channelDraft: readParam(params, "channelDraft"),
    channelWorkspace: readParam(params, "channelWorkspace"),
    channelConnection: readParam(params, "channelConnection"),
    channelRevision: /^[1-9][0-9]*$/.test(params.get("channelRevision") ?? "")
      ? Number(params.get("channelRevision"))
      : undefined,
    section: routeArea === "projects" ? undefined : (routeSection as AppRoute["section"]),
    mode: parsedMode,
    sessionId: readParam(params, "sessionId"),
    turnId: readParam(params, "turnId"),
    runId: readParam(params, "runId"),
    artifactId: readParam(params, "artifactId"),
    approvalId: readParam(params, "approvalId"),
    projectId:
      area === "projects"
        ? safeDecodePathSegment(rawParts[1]) || readParam(params, "projectId")
        : readParam(params, "projectId"),
    theme: readParam(params, "theme"),
    view: readParam(params, "view"),
    category: readParam(params, "category"),
    evidence: readParam(params, "evidence"),
    includeGlobal: readParam(params, "includeGlobal"),
    eventId: readParam(params, "eventId"),
  });
  return nextRoute;
}

export function buildAppHref(route: AppRoute): string {
  const next = normalizeAppRoute(route);
  const params = new URLSearchParams();
  writeParam(params, "channelPlan", next.channelPlan);
  writeParam(params, "channelDraft", next.channelDraft);
  writeParam(params, "channelWorkspace", next.channelWorkspace);
  writeParam(params, "channelConnection", next.channelConnection);
  if (next.channelRevision) params.set("channelRevision", String(next.channelRevision));
  writeParam(params, "sessionId", next.sessionId);
  writeParam(params, "turnId", next.turnId);
  writeParam(params, "runId", next.runId);
  writeParam(params, "artifactId", next.artifactId);
  writeParam(params, "approvalId", next.approvalId);
  if (next.area !== "projects") {
    writeParam(params, "projectId", next.projectId);
  }
  writeParam(params, "view", next.view);
  if (next.area === "library" && next.section === "journey") {
    writeParam(params, "category", next.category);
    writeParam(params, "evidence", next.evidence);
    writeParam(params, "includeGlobal", next.includeGlobal);
    writeParam(params, "eventId", next.eventId);
  }
  // theme is a global localStorage preference, not per-URL state (see 819ef761f); do not serialize it into hrefs.
  // Chat is the only operator conversation surface; legacy mode params are not serialized.

  const path =
    next.area === "chat"
      ? "/chat"
      : next.area === "projects"
        ? `/projects${next.projectId ? `/${encodeURIComponent(next.projectId)}` : ""}`
        : `/${next.area}/${next.section ?? ""}`;

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function isPrimaryArea(value: string | undefined): value is PrimaryArea {
  return (
    value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "projects" ||
    value === "library" ||
    value === "ops" ||
    value === "settings"
  );
}

function readParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

function safeDecodePathSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function writeParam(params: URLSearchParams, key: string, value?: string): void {
  if (value?.trim()) {
    params.set(key, value.trim());
  }
}
