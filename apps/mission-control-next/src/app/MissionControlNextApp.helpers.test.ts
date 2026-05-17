import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouteSurfaceFallback,
  buildRailSections,
  describeRealtimeTruthUi,
  formatUsd,
  isImmersiveRoute,
  renderRouteContent,
  resolveShellThemeClass,
  usesEmbeddedRouteHeader,
} from "./MissionControlNextApp";
import { RAIL_ITEMS } from "./route-model";

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
        item("providers"),
        item("personalities"),
        item("access"),
        item("runtime"),
        item("workspaces"),
        item("integrations"),
        item("mcp"),
        item("addons"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["workspaces"],
      ["providers", "personalities", "access"],
      ["integrations", "mcp"],
      ["onboarding", "runtime", "addons"],
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
        item("runtime"),
        item("diagnostics"),
        item("kanban"),
      ]).map((group) => group.items.map((entry) => entry.section)),
    ).toEqual([
      ["sessions", "schedules"],
      ["improvement", "notifications", "costs", "runtime", "diagnostics", "kanban"],
    ]);
    expect(buildRailSections("chat", [item("thread")])).toEqual([{ id: "chat-primary", items: [item("thread")] }]);
  });

  it("renders every declared grouped rail item exactly once", () => {
    for (const area of ["settings", "library", "ops"] as const) {
      const groupedItems = buildRailSections(area, RAIL_ITEMS[area]).flatMap((group) => group.items);
      expect(groupedItems.map((entry) => entry.id).sort()).toEqual(RAIL_ITEMS[area].map((entry) => entry.id).sort());
      expect(new Set(groupedItems.map((entry) => entry.id)).size).toBe(RAIL_ITEMS[area].length);
    }
  });

  it("describes theme, realtime, and embedded route chrome decisions", () => {
    expect(resolveShellThemeClass("dark")).toBe("theme-signal-noir");
    expect(resolveShellThemeClass("light")).toBe("theme-citadel-light");
    expect(describeRealtimeTruthUi("closed" as any, "authoritative").degraded).toBe(true);
    expect(describeRealtimeTruthUi("open" as any, "replay-gap").strip).toContain("replay recovery");
    expect(describeRealtimeTruthUi("open" as any, "compatibility").strip).toContain("compatibility");
    expect(describeRealtimeTruthUi("open" as any, "authoritative").degraded).toBe(false);
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

  it("dispatches route content helpers and preserves threaded route callbacks", () => {
    const navigate = vi.fn();
    const baseInput = {
      activeWorkspaceId: "workspace-1",
      activeWorkspaceName: "Workspace One",
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
});
