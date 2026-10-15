import { validNavigationId } from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import type {
  AppRoute,
  PrimaryArea,
  ReleaseSurfaceStatus,
  RouteReleaseScope,
  LibrarySection,
  OpsSection,
  SettingsSection,
} from "./route-model";

type RouteReleaseKeyInput = {
  area: PrimaryArea;
  section?: RouteReleaseScope["section"] | AppRoute["section"];
};

export function normalizeAppRoute(route: AppRoute): AppRoute {
  if (route.area === "code") {
    return normalizeAppRoute({ ...route, area: "chat", mode: undefined, section: undefined });
  }
  if (route.area === "cowork") {
    if (route.section === "tasks" || route.section === "board") {
      return normalizeAppRoute({ ...route, area: "ops", section: "kanban", mode: undefined });
    }
    return normalizeAppRoute({ ...route, area: "chat", mode: undefined, section: undefined });
  }

  const channelsRoute = route.area === "chat" || (route.area === "settings" && route.section === "channels");
  const base = {
    ...(channelsRoute
      ? {
          ...(validNavigationId(route.channelPlan) ? { channelPlan: route.channelPlan } : {}),
          ...(validNavigationId(route.channelDraft) ? { channelDraft: route.channelDraft } : {}),
          ...(validNavigationId(route.channelWorkspace) ? { channelWorkspace: route.channelWorkspace } : {}),
          ...(route.area === "chat" && Number.isSafeInteger(route.channelRevision) && (route.channelRevision ?? 0) > 0
            ? { channelRevision: route.channelRevision }
            : {}),
          ...(route.area === "settings" && validNavigationId(route.channelConnection)
            ? { channelConnection: route.channelConnection }
            : {}),
        }
      : {}),
    area: route.area,
    sessionId: route.sessionId,
    turnId: route.turnId,
    runId: route.runId,
    artifactId: route.artifactId,
    approvalId: route.approvalId,
    projectId: route.projectId,
    theme: route.theme,
    view: route.view,
    ...(route.area === "library" && route.section === "journey"
      ? {
          category: route.category,
          evidence: route.evidence,
          includeGlobal: route.includeGlobal,
          eventId: route.eventId,
        }
      : {}),
  };

  if (route.area === "library") {
    return {
      ...base,
      area: "library",
      section: (route.section as LibrarySection | undefined) ?? "agents",
    };
  }
  if (route.area === "ops") {
    return {
      ...base,
      area: "ops",
      section: (route.section as OpsSection | undefined) ?? "activity",
    };
  }
  if (route.area === "settings") {
    return {
      ...base,
      area: "settings",
      section: (route.section as SettingsSection | undefined) ?? "general",
    };
  }
  return {
    ...base,
    area: route.area,
    mode: route.area === "chat" && route.mode === "chat" ? "chat" : undefined,
  };
}

export function getRouteReleaseKey(route: RouteReleaseKeyInput): string {
  const section =
    route.area === "chat" || route.area === "code" || route.area === "projects"
      ? "root"
      : ((route.section as RouteReleaseScope["section"] | undefined) ?? defaultSectionForArea(route.area));
  return `${route.area}/${section}`;
}

export function describeReleaseSurfaceStatus(status: ReleaseSurfaceStatus): string {
  if (status === "ship") {
    return "Release-ready";
  }
  if (status === "needs_release_polish") {
    return "Needs release polish";
  }
  if (status === "experimental") {
    return "Experimental";
  }
  return "Direct URL only";
}

function defaultSectionForArea(area: PrimaryArea): RouteReleaseScope["section"] {
  if (area === "library") {
    return "agents";
  }
  if (area === "ops") {
    return "activity";
  }
  if (area === "settings") {
    return "general";
  }
  return "root";
}
