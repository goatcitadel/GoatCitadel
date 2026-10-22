import { describe, expect, it } from "vitest";
import * as routeModel from "./route-model";
import * as fullScopeOwner from "./route-release-scope";
import { readRouteReleaseStatus } from "./route-release-status";
import type { AppRoute, RouteReleaseScope } from "./route-model";

const EXPECTED_RAW_KEYS = [
  "chat/root",
  "cowork/workspace",
  "cowork/tasks",
  "cowork/board",
  "code/root",
  "projects/root",
  "library/agents",
  "library/skills",
  "library/capabilities",
  "library/memory",
  "library/journey",
  "library/knowledge",
  "library/notes",
  "library/communications",
  "library/files",
  "library/artifacts",
  "library/prompt-packs",
  "library/curator",
  "library/citadel",
  "library/citadel-overview",
  "library/citadel-wards",
  "library/citadel-council",
  "library/citadel-blueprint",
  "library/citadel-vault",
  "ops/boards",
  "ops/activity",
  "ops/sessions",
  "ops/schedules",
  "ops/workers",
  "ops/improvement",
  "ops/notifications",
  "ops/approvals",
  "ops/costs",
  "ops/quality",
  "ops/runtime",
  "ops/diagnostics",
  "ops/kanban",
  "settings/general",
  "settings/providers",
  "settings/personalities",
  "settings/access",
  "settings/permissions",
  "settings/trust-policy",
  "settings/budget",
  "settings/onboarding",
  "settings/runtime",
  "settings/local-ai",
  "settings/workspaces",
  "settings/addons",
  "settings/integrations",
  "settings/channels",
  "settings/mcp",
  "settings/web-search",
  "settings/tools",
  "settings/hooks",
  "settings/workspace-capabilities",
  "settings/citadel-capabilities",
] as const;

const HIDDEN_RAW_KEYS = new Set<string>([
  "cowork/workspace",
  "cowork/tasks",
  "cowork/board",
  "code/root",
  "ops/workers",
  "settings/workspace-capabilities",
  "settings/citadel-capabilities",
]);
const EXPERIMENTAL_RAW_KEYS = new Set<string>([
  "library/journey",
  "library/curator",
  "ops/improvement",
  "ops/kanban",
  "settings/personalities",
  "settings/addons",
]);

function routeFor(scope: RouteReleaseScope): AppRoute {
  return { area: scope.area, ...(scope.section === "root" ? {} : { section: scope.section }) };
}

describe("compact release metadata and full facade parity", () => {
  it("re-exports the canonical full owner by identity", () => {
    expect(routeModel.ROUTE_RELEASE_SCOPE).toBe(fullScopeOwner.ROUTE_RELEASE_SCOPE);
    expect(routeModel.getRouteReleaseScope).toBe(fullScopeOwner.getRouteReleaseScope);
    expect(routeModel.describeReleaseScopeForOperator).toBe(fullScopeOwner.describeReleaseScopeForOperator);
  });

  it("preserves all 57 raw records, statuses and public field order", () => {
    expect(EXPECTED_RAW_KEYS).toHaveLength(57);
    expect(routeModel.ROUTE_RELEASE_SCOPE).toHaveLength(57);
    expect(routeModel.ROUTE_RELEASE_SCOPE.map(routeModel.getRouteReleaseKey)).toEqual(EXPECTED_RAW_KEYS);
    expect(new Set(routeModel.ROUTE_RELEASE_SCOPE.map(routeModel.getRouteReleaseKey)).size).toBe(57);

    for (const scope of routeModel.ROUTE_RELEASE_SCOPE) {
      const key = routeModel.getRouteReleaseKey(scope);
      const expectedStatus = HIDDEN_RAW_KEYS.has(key)
        ? "hide"
        : EXPERIMENTAL_RAW_KEYS.has(key)
          ? "experimental"
          : "ship";
      expect(scope.status, key).toBe(expectedStatus);
      expect(readRouteReleaseStatus(key), key).toBe(expectedStatus);
      expect(Object.keys(scope), key).toEqual(["area", "section", "status", "releaseAction", "verification", "note"]);
      expect(scope.releaseAction.length, key).toBeGreaterThan(0);
      expect(scope.verification.length, key).toBeGreaterThan(0);
      expect(scope.note.length, key).toBeGreaterThan(0);
      expect(routeModel.isHiddenRoute(routeFor(scope)), key).toBe(HIDDEN_RAW_KEYS.has(key));
      expect(routeModel.isExperimentalRoute(routeFor(scope)), key).toBe(EXPERIMENTAL_RAW_KEYS.has(key));
    }
  });

  it("uses the same normalized canonical record for compact and full public lookup", () => {
    const byRawKey = new Map(
      routeModel.ROUTE_RELEASE_SCOPE.map((scope) => [routeModel.getRouteReleaseKey(scope), scope]),
    );
    for (const rawScope of routeModel.ROUTE_RELEASE_SCOPE) {
      const route = routeFor(rawScope);
      const normalizedKey = routeModel.getRouteReleaseKey(routeModel.normalizeAppRoute(route));
      const expected = byRawKey.get(normalizedKey);
      expect(expected, normalizedKey).toBeDefined();
      expect(routeModel.getRouteReleaseScope(route), normalizedKey).toBe(expected);
      expect(routeModel.getRouteReleaseStatus(route), normalizedKey).toBe(expected!.status);
    }
  });

  it.each([
    [{ area: "code" }, "code/root", { area: "chat" }, "chat/root", "ship"],
    [{ area: "cowork" }, "cowork/root", { area: "chat" }, "chat/root", "ship"],
    [{ area: "cowork", section: "workspace" }, "cowork/workspace", { area: "chat" }, "chat/root", "ship"],
    [
      { area: "cowork", section: "tasks" },
      "cowork/tasks",
      { area: "ops", section: "kanban" },
      "ops/kanban",
      "experimental",
    ],
    [
      { area: "cowork", section: "board" },
      "cowork/board",
      { area: "ops", section: "kanban" },
      "ops/kanban",
      "experimental",
    ],
  ] as const)(
    "keeps raw alias %j hidden while normalized public lookup reaches its owner",
    (route, rawKey, target, targetKey, status) => {
      const context = {
        sessionId: "session-1",
        runId: "run-1",
        turnId: "turn-1",
        approvalId: "approval-1",
        artifactId: "artifact-1",
        projectId: "project-1",
        theme: "light",
      };
      const contextualRoute: AppRoute = { ...route, ...context };
      const expected = routeModel.ROUTE_RELEASE_SCOPE.find(
        (scope) => routeModel.getRouteReleaseKey(scope) === targetKey,
      );

      expect(routeModel.getRouteReleaseKey(route)).toBe(rawKey);
      expect(readRouteReleaseStatus(rawKey)).toBe(rawKey === "cowork/root" ? undefined : "hide");
      expect(routeModel.isHiddenRoute(route)).toBe(true);
      expect(routeModel.isExperimentalRoute(route)).toBe(false);
      expect(routeModel.isPrimaryRailRoute(route)).toBe(false);
      expect(routeModel.normalizeAppRoute(contextualRoute)).toMatchObject({ ...target, ...context });
      expect(routeModel.getRouteReleaseScope(contextualRoute)).toBe(expected);
      expect(routeModel.getRouteReleaseStatus(contextualRoute)).toBe(status);
    },
  );

  it("retains default destinations and the one experimental rail exception", () => {
    for (const [route, key] of [
      [{ area: "library" }, "library/agents"],
      [{ area: "ops" }, "ops/activity"],
      [{ area: "settings" }, "settings/general"],
    ] as const) {
      const expected = routeModel.ROUTE_RELEASE_SCOPE.find((scope) => routeModel.getRouteReleaseKey(scope) === key);
      expect(routeModel.getRouteReleaseScope(route)).toBe(expected);
      expect(routeModel.getRouteReleaseStatus(route)).toBe("ship");
    }
    const discoverable = routeModel.ROUTE_RELEASE_SCOPE.filter((scope) =>
      routeModel.isPrimaryRailRoute(routeFor(scope)),
    ).map(routeModel.getRouteReleaseKey);
    expect(discoverable).toEqual(
      EXPECTED_RAW_KEYS.filter(
        (key) => !HIDDEN_RAW_KEYS.has(key) && (!EXPERIMENTAL_RAW_KEYS.has(key) || key === "settings/personalities"),
      ),
    );
    expect(routeModel.isExperimentalRoute({ area: "settings", section: "personalities" })).toBe(true);
    expect(routeModel.isPrimaryRailRoute({ area: "settings", section: "personalities" })).toBe(true);
    expect(routeModel.isPrimaryRailRoute({ area: "settings", section: "addons" })).toBe(false);
  });

  it.each([
    { area: "settings", section: "not-a-real-section" },
    { area: "settings", section: "__proto__" },
    { area: "ops", section: "constructor" },
  ])("fails closed for unknown or prototype-like metadata key %j", (unknownRoute) => {
    const route = unknownRoute as AppRoute;
    expect(readRouteReleaseStatus(routeModel.getRouteReleaseKey(route))).toBeUndefined();
    expect(routeModel.getRouteReleaseStatus(route)).toBe("hide");
    expect(routeModel.getRouteReleaseScope(route)).toEqual({
      area: route.area,
      section: "root",
      status: "hide",
      releaseAction: "Route is not part of the current visible release surface.",
      verification: "not release-bearing",
      note: "Missing route-scope metadata fails closed as hidden.",
    });
    expect(routeModel.isHiddenRoute(route)).toBe(true);
    expect(routeModel.isExperimentalRoute(route)).toBe(false);
    expect(routeModel.isPrimaryRailRoute(route)).toBe(false);
  });
});

describe("live canonical release status adapter", () => {
  it("observes an ordinary row.status assignment through every raw and normalized reader", () => {
    const row = routeModel.ROUTE_RELEASE_SCOPE.find(
      (scope) => scope.area === "settings" && scope.section === "addons",
    )!;
    const old = row.status,
      descriptor = Object.getOwnPropertyDescriptor(row, "status");
    expect(descriptor).toMatchObject({ enumerable: true, configurable: true, writable: true, value: old });
    // Prime the existing raw-key cache before changing the canonical row.
    expect(readRouteReleaseStatus("settings/addons")).toBe(old);
    try {
      row.status = "ship";
      expect(routeModel.getRouteReleaseScope({ area: "settings", section: "addons" })).toBe(row);
      expect(readRouteReleaseStatus("settings/addons")).toBe("ship");
      expect(routeModel.getRouteReleaseStatus({ area: "settings", section: "addons" })).toBe("ship");
      expect(routeModel.isHiddenRoute({ area: "settings", section: "addons" })).toBe(false);
      expect(routeModel.isExperimentalRoute({ area: "settings", section: "addons" })).toBe(false);
      expect(routeModel.isPrimaryRailRoute({ area: "settings", section: "addons" })).toBe(true);
      expect(Object.keys(row)).toEqual(["area", "section", "status", "releaseAction", "verification", "note"]);
    } finally {
      row.status = old;
    }
  });
  it.each(["__proto__", "constructor", "settings/__proto__", "ops/constructor", "missing/root"])(
    "fails closed for raw key %s",
    (key) => {
      expect(readRouteReleaseStatus(key)).toBeUndefined();
    },
  );
});
