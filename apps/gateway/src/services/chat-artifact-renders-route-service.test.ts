import { describe, expect, it, vi } from "vitest";
import type { ChatArtifactCritiqueResponse, ChatArtifactRenderResponse } from "@goatcitadel/contracts";
import {
  createChatArtifactRendersRouteService,
  type ChatArtifactRendersRoutePort,
} from "./chat-artifact-renders-route-service.js";
describe("typed artifact render route port", () => {
  it("forwards exact workspace, actor and authenticated admission without changing promise ownership", async () => {
    const rendered: ChatArtifactRenderResponse = { artifactId: "artifact-1", contentHash: "a".repeat(64), renders: [] };
    const critique: ChatArtifactCritiqueResponse = {
      sessionId: "session-1",
      turnId: "turn-1",
      visuallyInspected: false,
      renders: [],
    };
    const renderPromise = Promise.resolve(rendered),
      listPromise = Promise.resolve(rendered),
      critiquePromise = Promise.resolve(critique);
    const port = {
      renderChatGeneratedArtifact: vi.fn(() => renderPromise),
      listChatArtifactRenders: vi.fn(() => listPromise),
      critiqueChatGeneratedArtifact: vi.fn(() => critiquePromise),
    } satisfies ChatArtifactRendersRoutePort;
    const actor = { operatorId: "operator-1", authActorId: "operator-1", authActorSource: "token" as const },
      authenticatedOperator = Object.freeze({ marker: "canonical-admission" });
    const service = createChatArtifactRendersRouteService(port);
    expect(Object.isFrozen(service)).toBe(true);
    expect(service.renderChatGeneratedArtifact("artifact-1", "workspace-1")).toBe(renderPromise);
    expect(service.listChatArtifactRenders("artifact-1", "workspace-1")).toBe(listPromise);
    expect(service.critiqueChatGeneratedArtifact("artifact-1", "workspace-1", actor, authenticatedOperator)).toBe(
      critiquePromise,
    );
    await Promise.all([renderPromise, listPromise, critiquePromise]);
    expect(port.renderChatGeneratedArtifact).toHaveBeenCalledExactlyOnceWith("artifact-1", "workspace-1");
    expect(port.listChatArtifactRenders).toHaveBeenCalledExactlyOnceWith("artifact-1", "workspace-1");
    expect(port.critiqueChatGeneratedArtifact).toHaveBeenCalledExactlyOnceWith(
      "artifact-1",
      "workspace-1",
      actor,
      authenticatedOperator,
    );
  });
  it("preserves omission of the optional authenticated admission argument", async () => {
    const critique: ChatArtifactCritiqueResponse = {
      sessionId: "session-1",
      turnId: "turn-1",
      visuallyInspected: false,
      renders: [],
    };
    const promise = Promise.resolve(critique);
    const port = {
      renderChatGeneratedArtifact: vi.fn(),
      listChatArtifactRenders: vi.fn(),
      critiqueChatGeneratedArtifact: vi.fn(() => promise),
    } satisfies ChatArtifactRendersRoutePort;
    const actor = { operatorId: "operator-1" };
    expect(
      createChatArtifactRendersRouteService(port).critiqueChatGeneratedArtifact("artifact-1", "workspace-1", actor),
    ).toBe(promise);
    await promise;
    expect(port.critiqueChatGeneratedArtifact).toHaveBeenCalledExactlyOnceWith("artifact-1", "workspace-1", actor);
  });
});
