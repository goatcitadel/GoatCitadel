import type {
  ChatArtifactRenderResponse,
  ChatGeneratedArtifactRecord,
  RoutingPreflightResult,
} from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildArtifactCritiquePrompt,
  critiqueChatGeneratedArtifact,
  type HtmlArtifactCritiqueDependencies,
} from "./html-artifact-critique-service.js";

const now = "2026-10-12T10:00:00.000Z";
const CONTENT_HASH = "0123456789abcdef".repeat(4);

function artifactFixture(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "sess-1",
    workspaceId: "default",
    turnId: "turn-1",
    title: "Landing page",
    kind: "html",
    content: "<!doctype html><html><body><h1>Hi</h1></body></html>",
    sourceSurface: "chat",
    version: 2,
    contentHash: CONTENT_HASH,
    designAdvisories: [{ ruleId: "gradient-text", line: 4, summary: "Gradient text" }],
    createdAt: now,
    ...overrides,
  };
}

function rendersFixture(): ChatArtifactRenderResponse {
  const base = { artifactId: "artifact-1", contentHash: CONTENT_HASH, sha256: "b".repeat(64), createdAt: now };
  return {
    artifactId: "artifact-1",
    contentHash: CONTENT_HASH,
    renders: [
      { ...base, viewport: "desktop", attachmentId: "att-desktop", width: 1440, height: 900 },
      { ...base, viewport: "phone", attachmentId: "att-phone", width: 390, height: 844 },
    ],
  };
}

function preflightFixture(providerId: string): RoutingPreflightResult {
  const decision = {
    action: "send" as const,
    issuedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    requestedProviderId: providerId,
    requestedModel: "model-x",
    effectiveProviderId: providerId,
    effectiveModel: "model-x",
    selectionSource: "session" as const,
    fallbackPolicy: "off" as const,
    fallbackResult: "not_applicable" as const,
    runtimeReachability: "not_checked" as const,
    runtimeClass: "cloud" as const,
    fingerprint: "fp",
  };
  return { ...decision, decision } as unknown as RoutingPreflightResult;
}

const actor = { operatorId: "operator-1", authActorId: "operator-1", authActorSource: "token" as const };

function createDeps(input: { providerId: string; vision: boolean; artifact?: ChatGeneratedArtifactRecord }) {
  const artifact = input.artifact ?? artifactFixture();
  const sendChatTurn = vi.fn(async () => ({ sessionId: artifact.sessionId, turnId: "ignored" }));
  const deps: HtmlArtifactCritiqueDependencies = {
    getChatGeneratedArtifact: vi.fn(async () => artifact),
    renderChatGeneratedArtifact: vi.fn(async () => rendersFixture()),
    routePreflight: vi.fn(async () => preflightFixture(input.providerId)),
    providerSupportsVision: vi.fn((providerId: string) => providerId === input.providerId && input.vision),
    sendChatTurn: sendChatTurn as unknown as HtmlArtifactCritiqueDependencies["sendChatTurn"],
    backgroundTasks: new Set<Promise<unknown>>(),
    log: { warn: vi.fn() },
  };
  return { deps, sendChatTurn };
}

describe("critiqueChatGeneratedArtifact", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a critique turn with the renders attached when the effective provider can see images", async () => {
    const { deps, sendChatTurn } = createDeps({ providerId: "openai", vision: true });

    const result = await critiqueChatGeneratedArtifact(deps, "artifact-1", "default", actor);

    expect(deps.renderChatGeneratedArtifact).toHaveBeenCalledWith("artifact-1", "default");
    expect(deps.routePreflight).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ action: "send", operatorId: "operator-1", authActorId: "operator-1" }),
    );
    expect(result).toEqual({
      sessionId: "sess-1",
      turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      visuallyInspected: true,
      renders: rendersFixture().renders,
    });
    expect(sendChatTurn).toHaveBeenCalledTimes(1);
    const [sessionId, request, turnIdentity] = sendChatTurn.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { turnId: string },
    ];
    expect(sessionId).toBe("sess-1");
    expect(turnIdentity.turnId).toBe(result.turnId);
    expect(request).toMatchObject({
      attachments: ["att-desktop", "att-phone"],
      contextRefs: [{ kind: "generated_artifact", ref: "artifact-1", label: "Landing page" }],
      providerId: "openai",
      model: "model-x",
      mode: "chat",
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
    });
    expect(request.routeDecision).toEqual(preflightFixture("openai").decision);
    expect(String(request.content)).toContain("@skill impeccable critique");
    expect(String(request.content)).toContain("desktop (1440×900) and phone (390×844)");
    expect(String(request.content)).toContain("1 runtime design advisor");
    expect(String(request.content)).not.toContain("text-only");
    await Promise.all(deps.backgroundTasks);
  });

  it("sends a text-only critique with the marker when the provider cannot inspect images", async () => {
    const { deps, sendChatTurn } = createDeps({ providerId: "local-llama", vision: false });

    const result = await critiqueChatGeneratedArtifact(deps, "artifact-1", "default", actor);

    expect(result.visuallyInspected).toBe(false);
    const request = sendChatTurn.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty("attachments");
    expect(String(request.content)).toContain("Render evidence unavailable");
    expect(String(request.content)).toContain("text-only");
    expect(String(request.content)).toContain("local-llama");
  });

  it("returns after dispatch and logs a failed turn instead of throwing", async () => {
    const { deps, sendChatTurn } = createDeps({ providerId: "openai", vision: true });
    sendChatTurn.mockRejectedValueOnce(new Error("provider down"));

    const result = await critiqueChatGeneratedArtifact(deps, "artifact-1", "default", actor);

    expect(result.sessionId).toBe("sess-1");
    await Promise.all(deps.backgroundTasks);
    await vi.waitFor(() =>
      expect(deps.log.warn).toHaveBeenCalledWith("artifact critique turn failed", expect.anything()),
    );
    expect(deps.backgroundTasks.size).toBe(0);
  });

  it("refuses to dispatch when the route is blocked or resolves no provider", async () => {
    const blocked = createDeps({ providerId: "openai", vision: true });
    blocked.deps.routePreflight = vi.fn(async () => ({
      ...preflightFixture("openai"),
      blockedReason: "No provider is configured for this session.",
    }));
    await expect(critiqueChatGeneratedArtifact(blocked.deps, "artifact-1", "default", actor)).rejects.toMatchObject({
      httpStatus: 409,
      message: expect.stringContaining("No provider is configured"),
    });
    expect(blocked.sendChatTurn).not.toHaveBeenCalled();

    const unrouted = createDeps({ providerId: "openai", vision: true });
    const noProvider = preflightFixture("openai") as unknown as Record<string, unknown>;
    delete noProvider.effectiveProviderId;
    unrouted.deps.routePreflight = vi.fn(async () => noProvider as unknown as RoutingPreflightResult);
    await expect(critiqueChatGeneratedArtifact(unrouted.deps, "artifact-1", "default", actor)).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(unrouted.sendChatTurn).not.toHaveBeenCalled();
  });

  it("builds a prompt that never embeds the artifact markup", () => {
    const prompt = buildArtifactCritiquePrompt({
      artifact: artifactFixture({ designAdvisories: [] }),
      visuallyInspected: false,
      effectiveProviderId: "local-llama",
    });

    expect(prompt).toContain("Landing page");
    expect(prompt).toContain("no runtime design advisories");
    expect(prompt).not.toContain("<h1>Hi</h1>");
  });
});
