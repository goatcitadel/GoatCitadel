import { describe, expect, it, vi } from "vitest";
import {
  buildMissionControlResolverId,
  parseRemoteApprovalActionPrompt,
  readThemeOverrideFromLocation,
  resolveShellThemeClass,
} from "./App";

describe("App loop 32 shell helper tails", () => {
  it("ignores unknown theme overrides while preserving explicit light and dark aliases", () => {
    const originalWindow = globalThis.window;

    vi.stubGlobal("window", {
      location: {
        hostname: "ops.local",
        search: "?theme=unknown",
      },
    });
    expect(readThemeOverrideFromLocation()).toBeNull();
    expect(resolveShellThemeClass("dark")).toBe("theme-signal-noir");
    expect(buildMissionControlResolverId()).toBe("mission-control:ops.local");

    vi.stubGlobal("window", {
      location: {
        hostname: "ops.local",
        search: "?theme=light",
      },
    });
    expect(readThemeOverrideFromLocation()).toBe("light");
    expect(resolveShellThemeClass("dark")).toBe("theme-citadel-light");

    vi.stubGlobal("window", originalWindow);
  });

  it("defaults sparse remote approval prompts and drops non-object previews", () => {
    expect(
      parseRemoteApprovalActionPrompt({
        payload: {
          payload: {
            approvalId: "approval-loop32",
            tokenId: "token-loop32",
            token: "secret-loop32",
            preview: ["not", "an", "object"],
          },
        },
      } as any),
    ).toEqual({
      approvalId: "approval-loop32",
      actionType: "approval.resolve",
      tokenId: "token-loop32",
      token: "secret-loop32",
      kind: "approval",
      riskLevel: "danger",
      status: "pending",
      preview: undefined,
      expiresAt: undefined,
    });
  });
});
