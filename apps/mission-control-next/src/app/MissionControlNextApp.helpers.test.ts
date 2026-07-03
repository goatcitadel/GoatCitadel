import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouteSurfaceFallback,
  buildRailSections,
  describeDashboardFooterPill,
  describeRealtimeTruthUi,
  formatUsd,
  isImmersiveRoute,
  renderRouteContent,
  resolveEffectiveShellTheme,
  resolveShellThemeClass,
  usesEmbeddedRouteHeader,
} from "./MissionControlNextApp";
import { RAIL_ITEMS, getRouteReleaseScope, isExperimentalRoute } from "./route-model";

const item = (section: string) => ({ section }) as any;

describe("MissionControlNextApp shell helpers", () => {
  it("groups rail sections by product area", () => {
    expect(buildRailSections("settings", [item("general"), item("channels"), item("tools")])).toEqual([
      { id: "settings-foundations", label: "Foundations", items: [item("general")] },
      { id: "settings-surfaces", label: "Surfaces", items: [item("channels"), item("tools")] },
    ]);
    expect(
      buildRailSections("settings", [
        item("onboarding"),
        item("permissions"),
        item("providers"),
        item("trust-policy"),
        item("personalities"),
        item("access"),
        item("runtime"),
        item("workspaces"),
        item("integrations"),
        item("mcp"),
        item("addons"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["onboarding", "workspaces"],
      ["permissions", "providers", "trust-policy", "personalities", "access"],
      ["integrations", "mcp"],
      ["runtime", "addons"],
    ]);
    expect(
      buildRailSections("library", [item("memory"), item("prompt-packs"), item("curator")]).map((group) => group.id),
    ).toEqual(["library-knowledge", "library-assets"]);
    expect(buildRailSections("ops", [item("activity"), item("approvals")]).map((group) => group.id)).toEqual([
      "ops-observe",
      "ops-control",
    ]);
    expect(
      buildRailSections("ops", [
        item("sessions"),
        item("schedules"),
        item("improvement"),
        item("notifications"),
        item("costs"),
        item("quality"),
        item("runtime"),
        item("diagnostics"),
        item("kanban"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["sessions", "schedules"],
      ["improvement", "notifications", "costs", "quality", "runtime", "diagnostics", "kanban"],
    ]);
    expect(buildRailSections("chat", [item("thread")])).toEqual([{ id: "chat-primary", items: [item("thread")] }]);
  });

  it("renders every declared grouped rail item exactly once", () => {
    for (const area of ["settings", "library", "ops"] as const) {
      const groupedItems = buildRailSections(area, RAIL_ITEMS[area]).flatMap((group) => group.items);
      const expectedIds = RAIL_ITEMS[area].map((entry) => entry.id).sort();
      expect(groupedItems.map((entry) => entry.id).sort()).toEqual(expectedIds);
      expect(new Set(groupedItems.map((entry) => entry.id)).size).toBe(expectedIds.length);
    }
  });

  it("keeps non-experimental ship routes represented in primary grouped navigation", () => {
    const explicitExemptions = new Set<string>();

    for (const area of ["settings", "library", "ops"] as const) {
      const groupedIds = new Set(
        buildRailSections(area, RAIL_ITEMS[area])
          .flatMap((group) => group.items)
          .map((entry) => entry.id),
      );
      for (const entry of RAIL_ITEMS[area]) {
        const route = { area: entry.area, section: entry.section };
        const releaseScope = getRouteReleaseScope(route);
        const routeKey = `${entry.area}/${entry.section ?? "root"}`;
        if (releaseScope.status === "ship" && !isExperimentalRoute(route) && !explicitExemptions.has(routeKey)) {
          expect(groupedIds.has(entry.id)).toBe(true);
        }
      }
    }
  });

  it("describes theme, realtime, and embedded route chrome decisions", () => {
    expect(resolveShellThemeClass("dark")).toBe("theme-signal-noir");
    expect(resolveShellThemeClass("light")).toBe("theme-citadel-light");
    expect(resolveEffectiveShellTheme("dark", "light")).toBe("dark");
    expect(resolveEffectiveShellTheme("light", "dark")).toBe("light");
    expect(resolveEffectiveShellTheme("library", "dark")).toBe("dark");
    expect(resolveEffectiveShellTheme(undefined, "light")).toBe("light");
    expect(describeRealtimeTruthUi("closed" as any, "authoritative").degraded).toBe(true);
    expect(describeRealtimeTruthUi("open" as any, "replay-gap").strip).toContain("replay recovery");
    // replay-gap stays degraded even while OPEN (unchanged from before).
    expect(describeRealtimeTruthUi("open" as any, "replay-gap").degraded).toBe(true);
    expect(describeRealtimeTruthUi("open" as any, "authoritative").degraded).toBe(false);
    // N1: while the stream is OPEN, "compatibility" truth-mode is per-event topic
    // inference nuance, not a transport degradation. The badge/strip must read
    // healthy ("Live"); only the inspector detail line keeps the softened nuance.
    const openCompatibility = describeRealtimeTruthUi("open" as any, "compatibility");
    expect(openCompatibility.degraded).toBe(false);
    expect(openCompatibility.badge).toBe("Live");
    expect(openCompatibility.strip).toBe("Streaming");
    expect(openCompatibility.inspector).toContain("inferred refresh");
    // Non-open stream states keep today's degraded treatment even for
    // "compatibility" — the branch above only relaxes the OPEN case.
    expect(describeRealtimeTruthUi("closed" as any, "compatibility").degraded).toBe(true);
    expect(describeRealtimeTruthUi("connecting" as any, "compatibility").degraded).toBe(true);
    expect(isImmersiveRoute({ area: "library", section: "prompt-packs" } as any)).toBe(true);
    expect(isImmersiveRoute({ area: "library", section: "memory" } as any)).toBe(false);
    expect(usesEmbeddedRouteHeader({ area: "cowork", section: "tasks" } as any)).toBe(true);
    expect(usesEmbeddedRouteHeader({ area: "chat" } as any)).toBe(false);
    expect(usesEmbeddedRouteHeader({ area: "cowork", section: "chat" } as any)).toBe(false);
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(2.34567)).toBe("$2.3457");
  });

  it("marks dashboard footer pills unavailable when the dashboard refresh fails (F-H4)", () => {
    const dashboard = { sessions: [{}, {}], pendingApprovals: 3, dailyCostUsd: 1.5 } as any;
    // Healthy: the formatted value passes through, not degraded.
    expect(describeDashboardFooterPill(dashboard, null, "3 pending")).toEqual({
      value: "3 pending",
      degraded: false,
    });
    // Dashboard never loaded: em dash, not degraded.
    expect(describeDashboardFooterPill(null, null, "—")).toEqual({ value: "—", degraded: false });
    // Refresh failed while a stale dashboard is retained: do NOT show the stale
    // "3 pending"; mark it unavailable + degraded so the strip cannot lie.
    expect(describeDashboardFooterPill(dashboard, "boom", "3 pending")).toEqual({
      value: "Unavailable",
      degraded: true,
    });
    // Failure takes precedence even when no dashboard object exists.
    expect(describeDashboardFooterPill(null, "boom", "—")).toEqual({ value: "Unavailable", degraded: true });
  });

  it("dispatches route content helpers and preserves threaded route callbacks", () => {
    const navigate = vi.fn();
    const gatewayStatus = {
      ready: true,
      tone: "success",
      label: "Gateway ready",
      detail: "Gateway ready. Daemon health is serving.",
    } as const;
    const baseInput = {
      activeWorkspaceId: "workspace-1",
      activeWorkspaceName: "Workspace One",
      gatewayStatus,
      pendingApprovals: 2,
      navigate,
      setActiveWorkspaceId: vi.fn(),
    };

    const chatElement = renderRouteContent({
      ...baseInput,
      route: { area: "chat", sessionId: "chat-session", theme: "library" } as any,
    }) as any;
    chatElement.props.onOpenCowork();
    chatElement.props.onOpenCode();
    chatElement.props.onOpenTasks();
    chatElement.props.onOpenApprovals();
    chatElement.props.onNavigateSurface("code", {
      sessionId: "next-session",
      turnId: "turn-1",
      artifactId: "artifact-1",
    });

    expect(navigate).toHaveBeenCalledWith({ area: "cowork", theme: "library", sessionId: "chat-session" });
    expect(navigate).toHaveBeenCalledWith({ area: "code", theme: "library", sessionId: "chat-session" });
    expect(navigate).toHaveBeenCalledWith({ area: "cowork", section: "tasks", theme: "library" });
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "approvals", theme: "library" });
    expect(navigate).toHaveBeenCalledWith({
      area: "code",
      theme: "library",
      sessionId: "next-session",
      turnId: "turn-1",
      artifactId: "artifact-1",
    });

    const coworkElement = renderRouteContent({
      ...baseInput,
      route: { area: "cowork", sessionId: "cowork-session", theme: "ops" } as any,
    }) as any;
    coworkElement.props.onOpenCode();
    coworkElement.props.onOpenTasks();
    coworkElement.props.onOpenApprovals();
    coworkElement.props.onNavigateSurface("chat", {});
    expect(navigate).toHaveBeenCalledWith({ area: "code", theme: "ops", sessionId: "cowork-session" });
    expect(navigate).toHaveBeenCalledWith({ area: "cowork", section: "tasks", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "approvals", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      theme: "ops",
      sessionId: undefined,
      turnId: undefined,
      artifactId: undefined,
    });

    const codeElement = renderRouteContent({
      ...baseInput,
      route: { area: "code", sessionId: "code-session", theme: "ops" } as any,
    }) as any;
    codeElement.props.onOpenCowork();
    codeElement.props.onOpenTasks();
    codeElement.props.onOpenApprovals();
    codeElement.props.onNavigateSurface("cowork", { sessionId: "handoff-session" });
    expect(navigate).toHaveBeenCalledWith({ area: "cowork", theme: "ops", sessionId: "code-session" });
    expect(navigate).toHaveBeenCalledWith({ area: "cowork", section: "tasks", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "approvals", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({
      area: "cowork",
      theme: "ops",
      sessionId: "handoff-session",
      turnId: undefined,
      artifactId: undefined,
    });

    const promptPacksElement = renderRouteContent({
      ...baseInput,
      route: { area: "library", section: "prompt-packs" } as any,
    }) as any;
    expect(promptPacksElement.props.variant).toBe("library");
    expect(promptPacksElement.props.workspaceId).toBe("workspace-1");

    for (const route of [
      { area: "cowork", section: "tasks" },
      { area: "cowork", section: "board" },
      { area: "projects", projectId: "project-1" },
      { area: "library", section: "memory" },
      { area: "ops", section: "runtime" },
      { area: "settings", section: "general" },
    ] as any[]) {
      const element = renderRouteContent({ ...baseInput, route }) as any;
      expect(element.props.route.area).toBe(route.area);
    }

    expect(
      renderToStaticMarkup(RouteSurfaceFallback({ label: "Runtime", description: "Loading runtime route." }) as any),
    ).toContain("Loading Runtime");
  });

  it("keeps the rail-hidden experimental routes scoped and reachable (F-M11)", () => {
    // The three surfaces that have no rail entry and previously no palette entry.
    const experimentalRoutes = [
      { area: "library", section: "curator" },
      { area: "ops", section: "improvement" },
      { area: "ops", section: "kanban" },
    ] as const;

    for (const route of experimentalRoutes) {
      // Still flagged experimental in ROUTE_RELEASE_SCOPE (drives the on-surface badge).
      expect(isExperimentalRoute(route as any)).toBe(true);
      expect(getRouteReleaseScope(route as any).status).toBe("experimental");
      // Still reachable: the route dispatcher renders the surface, never a "hidden" no-op.
      const element = renderRouteContent({
        route: route as any,
        activeWorkspaceId: "workspace-1",
        activeWorkspaceName: "Workspace One",
        gatewayStatus: {
          ready: true,
          tone: "success",
          label: "Gateway ready",
          detail: "Gateway ready. Daemon health is serving.",
        },
        pendingApprovals: 0,
        navigate: vi.fn(),
        setActiveWorkspaceId: vi.fn(),
      }) as any;
      expect(element).toBeTruthy();
      expect(element.props.route.area).toBe(route.area);
    }
  });
});
