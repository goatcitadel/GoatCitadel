import { describe, expect, it, vi } from "vitest";
import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";

vi.mock("sqlite", () => ({}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createPrefs(
  overrides: Partial<ChatSessionPrefsRecord> = {},
): ChatSessionPrefsRecord {
  return {
    sessionId: "sess-1",
    mode: "chat",
    planningMode: "off",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "summarized",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "auto",
    codeAutoApply: "aggressive_auto",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("GatewayService chat session provider normalization", () => {
  it("treats outbound hosts as implicitly allowed under the danger tool profile", () => {
    const gateway = Object.create(GatewayService.prototype) as GatewayService & {
      config: {
        toolPolicy: {
          tools: { profile: string };
          sandbox: { networkAllowlist: string[] };
        };
      };
    };

    gateway.config = {
      toolPolicy: {
        tools: { profile: "danger" },
        sandbox: { networkAllowlist: [] },
      },
    };

    expect((GatewayService.prototype as any).isUrlAllowlisted.call(gateway, "https://lite.duckduckgo.com/lite/?q=test")).toBe(true);
    expect((GatewayService.prototype as any).isHostAllowlisted.call(gateway, "www.google.com")).toBe(true);
  });

  it("repairs stale cross-provider model selections to the selected provider default", () => {
    const initialPrefs = createPrefs({
      providerId: "openai",
      model: "claude-sonnet-4-6",
    });
    const patchedPrefs = createPrefs({
      providerId: "openai",
      model: "gpt-5.4-mini",
      updatedAt: "2026-04-03T00:01:00.000Z",
    });

    const gateway = Object.create(GatewayService.prototype) as any;

    gateway.getSession = vi.fn(() => ({ sessionId: "sess-1" }));
    gateway.hydrateChatPrefsWithAutonomy = vi.fn((_sessionId: string, prefs: ChatSessionPrefsRecord) => prefs);
    gateway.llmService = {
      getRuntimeConfig: vi.fn(() => ({
        activeProviderId: "openai",
        activeModel: "gpt-5.4",
        providers: [
          { providerId: "openai", defaultModel: "gpt-5.4-mini", hasApiKey: true },
          { providerId: "glm", defaultModel: "glm-5", hasApiKey: true },
        ],
      })),
    };
    gateway.storage = {
      chatSessionPrefs: {
        ensure: vi.fn(() => initialPrefs),
        patch: vi.fn(() => patchedPrefs),
      },
    };

    const prefs = GatewayService.prototype.getChatSessionPrefs.call(gateway, "sess-1");

    expect(gateway.storage.chatSessionPrefs.patch).toHaveBeenCalledWith("sess-1", {
      model: "gpt-5.4-mini",
    });
    expect(prefs.providerId).toBe("openai");
    expect(prefs.model).toBe("gpt-5.4-mini");
  });
});
