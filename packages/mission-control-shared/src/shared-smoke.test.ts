import { describe, expect, it } from "vitest";
import { fetchWorkspaces } from "./api/client";
import { resolveEffectiveEffectsMode } from "./state/effects-mode";
import { pageCopy } from "./content/copy";
import { upsertNotificationItem } from "./components/NotificationStack";

describe("mission-control-shared smoke", () => {
  it("exposes stable shared helpers", () => {
    expect(typeof fetchWorkspaces).toBe("function");
    expect(pageCopy.chat.title.length).toBeGreaterThan(0);
    expect(resolveEffectiveEffectsMode("full")).toBe("full");
    expect(resolveEffectiveEffectsMode("reduced")).toBe("reduced");
  });

  it("groups duplicate notifications", () => {
    const first = {
      id: "1",
      tone: "info" as const,
      message: "hello",
      timestamp: 1,
    };
    const second = {
      id: "2",
      tone: "info" as const,
      message: "hello",
      timestamp: 2,
    };

    const items = upsertNotificationItem([first], second, 6);
    expect(items).toHaveLength(1);
    expect(items[0]?.count).toBe(2);
    expect(items[0]?.id).toBe("1");
  });
});
