import { describe, expect, it, vi } from "vitest";
import {
  buildMissionControlResolverId,
  deriveGeneralTab,
  deriveHealthTab,
  deriveOperateStatusFreshness,
  deriveShellApprovalCount,
  deriveTimelineTab,
  deriveWorkspacesTab,
  getStartupMonotonicNow,
  isEditableTarget,
  parseDeviceAccessPrompt,
  parseRemoteApprovalActionPrompt,
  readDeviceAccessPromptField,
  readThemeOverrideFromLocation,
  resolveShellRailDefaultSize,
  resolveShellThemeClass,
  upsertDeviceAccessPrompt,
  upsertRemoteApprovalPrompt,
} from "./App";

describe("App loop 13 shell derivations", () => {
  it("covers shell count, freshness, tab, rail, and no-window theme branches", () => {
    expect(deriveShellApprovalCount(null, -4)).toBe(0);
    expect(deriveShellApprovalCount({ pendingApprovals: 3 } as any, 2)).toBe(5);

    expect(deriveOperateStatusFreshness(null, null, 1000)).toEqual({
      state: "stale",
      note: "Waiting for the first shell status refresh.",
    });
    expect(deriveOperateStatusFreshness(null, "offline", 1000)).toEqual({
      state: "stale",
      note: "Status refresh has not completed yet.",
    });
    expect(deriveOperateStatusFreshness(1, "timeout", 1000).note).toContain("latest dashboard refresh failed");
    expect(deriveOperateStatusFreshness(1, null, 50_002).note).toContain("has not refreshed recently");
    expect(deriveOperateStatusFreshness(49_000, null, 50_000)).toEqual({
      state: "live",
      note: "Counts reflect the latest dashboard snapshot.",
    });

    expect(deriveTimelineTab({ space: "configure", page: "settings" } as any)).toBe("activity");
    expect(deriveTimelineTab({ space: "observe", page: "sessions" } as any)).toBe("sessions");
    expect(deriveTimelineTab({ space: "observe", page: "activity", tab: "scheduler" } as any)).toBe("scheduler");
    expect(deriveTimelineTab({ space: "observe", page: "activity", tab: "improvement" } as any)).toBe("improvement");

    expect(deriveHealthTab({ space: "observe", page: "system" } as any)).toBe("system");
    expect(deriveHealthTab({ space: "observe", page: "costs" } as any)).toBe("costs");
    expect(deriveGeneralTab({ space: "configure", page: "settings", tab: "access" } as any)).toBe("access");
    expect(deriveGeneralTab({ space: "configure", page: "integrations", tab: "channels" } as any)).toBe("general");
    expect(deriveWorkspacesTab({ space: "configure", page: "settings", tab: "addons" } as any)).toBe("addons");
    expect(deriveWorkspacesTab({ space: "configure", page: "settings", tab: "general" } as any)).toBe("workspaces");
    expect(resolveShellRailDefaultSize("expanded")).toBe(264);
    expect(resolveShellRailDefaultSize("compact")).toBe(176);
    expect(resolveShellRailDefaultSize("icon")).toBe(92);

    const originalWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(readThemeOverrideFromLocation()).toBeNull();
    expect(resolveShellThemeClass("light")).toBe("theme-citadel-light");
    expect(buildMissionControlResolverId()).toBe("mission-control");
    vi.stubGlobal("window", originalWindow);
  });

  it("reads explicit theme aliases and resolver host from the browser location", () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal("window", {
      location: {
        hostname: "ops.local",
        search: "?theme=theme-signal-noir",
      },
    });
    expect(readThemeOverrideFromLocation()).toBe("dark");
    expect(resolveShellThemeClass("light")).toBe("theme-signal-noir");
    expect(buildMissionControlResolverId()).toBe("mission-control:ops.local");

    vi.stubGlobal("window", {
      location: {
        hostname: "ops.local",
        search: "?theme=theme-citadel-light",
      },
    });
    expect(readThemeOverrideFromLocation()).toBe("light");
    expect(resolveShellThemeClass("dark")).toBe("theme-citadel-light");
    vi.stubGlobal("window", originalWindow);
  });

  it("parses and upserts realtime approval prompts defensively", () => {
    expect(readDeviceAccessPromptField({ token: "  abc  ", empty: " ", number: 1 }, "token")).toBe("abc");
    expect(readDeviceAccessPromptField({ token: "  abc  ", empty: " ", number: 1 }, "empty")).toBeUndefined();
    expect(readDeviceAccessPromptField({ token: "  abc  ", empty: " ", number: 1 }, "number")).toBeUndefined();

    expect(parseDeviceAccessPrompt({ payload: { approvalId: "approval-1" } } as any)).toBeUndefined();
    expect(
      parseDeviceAccessPrompt({
        payload: {
          approvalId: " approval-1 ",
          requestId: " request-1 ",
          deviceType: "desktop",
          platform: "windows",
          requestedIp: "127.0.0.1",
          requestedOrigin: "http://localhost:5173",
          createdAt: "2026-05-14T12:00:00.000Z",
        },
      } as any),
    ).toEqual({
      approvalId: "approval-1",
      requestId: "request-1",
      deviceLabel: "New device",
      deviceType: "desktop",
      platform: "windows",
      requestedIp: "127.0.0.1",
      requestedOrigin: "http://localhost:5173",
      createdAt: "2026-05-14T12:00:00.000Z",
    });
    expect(
      upsertDeviceAccessPrompt(
        [
          { approvalId: "approval-1", requestId: "old", deviceLabel: "Old" },
          { approvalId: "approval-2", requestId: "two", deviceLabel: "Two" },
        ],
        { approvalId: "approval-1", requestId: "new", deviceLabel: "New" },
      ),
    ).toEqual([
      { approvalId: "approval-1", requestId: "new", deviceLabel: "New" },
      { approvalId: "approval-2", requestId: "two", deviceLabel: "Two" },
    ]);

    expect(parseRemoteApprovalActionPrompt({ payload: { payload: null } } as any)).toBeUndefined();
    expect(parseRemoteApprovalActionPrompt({ payload: { payload: [] } } as any)).toBeUndefined();
    expect(
      parseRemoteApprovalActionPrompt({ payload: { payload: { approvalId: "approval-1" } } } as any),
    ).toBeUndefined();
    expect(
      parseRemoteApprovalActionPrompt({
        payload: {
          payload: {
            approvalId: " approval-3 ",
            tokenId: " token-3 ",
            token: " secret ",
            kind: "tool",
            riskLevel: "high",
            status: "pending",
            preview: { action: "approve" },
            expiresAt: "2026-05-14T13:00:00.000Z",
          },
        },
      } as any),
    ).toEqual({
      approvalId: "approval-3",
      actionType: "approval.resolve",
      tokenId: "token-3",
      token: "secret",
      kind: "tool",
      riskLevel: "high",
      status: "pending",
      preview: { action: "approve" },
      expiresAt: "2026-05-14T13:00:00.000Z",
    });
    expect(
      upsertRemoteApprovalPrompt(
        [
          { approvalId: "approval-3", actionType: "approval.resolve", tokenId: "old", token: "old" } as any,
          { approvalId: "approval-4", actionType: "approval.resolve", tokenId: "four", token: "four" } as any,
        ],
        { approvalId: "approval-3", actionType: "approval.resolve", tokenId: "new", token: "new" } as any,
      ).map((item) => item.tokenId),
    ).toEqual(["new", "four"]);
  });

  it("covers startup clock and editable-target detection fallbacks", () => {
    const originalPerformance = globalThis.performance;
    vi.stubGlobal("performance", undefined);
    expect(getStartupMonotonicNow()).toBeGreaterThan(0);
    vi.stubGlobal("performance", { now: () => 123.5 });
    expect(getStartupMonotonicNow()).toBe(123.5);
    vi.stubGlobal("performance", originalPerformance);

    const originalHTMLElement = globalThis.HTMLElement;
    class FakeHTMLElement {
      isContentEditable = false;

      constructor(readonly tagName: string) {}
    }
    vi.stubGlobal("HTMLElement", FakeHTMLElement);

    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
    expect(isEditableTarget(new FakeHTMLElement("INPUT") as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(new FakeHTMLElement("TEXTAREA") as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(new FakeHTMLElement("SELECT") as unknown as EventTarget)).toBe(true);
    const div = new FakeHTMLElement("DIV");
    div.isContentEditable = true;
    expect(isEditableTarget(div as unknown as EventTarget)).toBe(true);
    vi.stubGlobal("HTMLElement", originalHTMLElement);
  });
});
