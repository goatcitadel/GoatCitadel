import { describe, expect, it, vi } from "vitest";
import {
  resolveLiveModelCouncilBinding,
  resolveModelCouncilPrimaryRoute,
  selectModelCouncilCandidates,
  type ModelCouncilCandidateLlm,
} from "./chat-model-council-binding.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

function prepared(overrides: Partial<PreparedAgentChatTurn> = {}): PreparedAgentChatTurn {
  return {
    turnId: "turn-1",
    workspaceId: "workspace-1",
    session: { sessionId: "session-1" },
    prefs: { thinkingLevel: "standard" },
    normalized: {},
    turnAdmission: { identity: { admissionId: "admission-1" } },
    featureAdmission: {
      references: {
        version: "chat.turn.feature-references.v1",
        providerRoute: { primary: { providerId: "local", model: "small" }, fingerprint: "a".repeat(64) },
        modelCouncil: { version: "chat.model-council.admission.v1" },
      },
      referenceSha256: "b".repeat(64),
    },
    ...overrides,
  } as unknown as PreparedAgentChatTurn;
}

function llm(refusedProviders: string[] = []) {
  const admitsDispatchWard = vi.fn(
    async (_attribution: unknown, providerId: string) => !refusedProviders.includes(providerId),
  );
  const service = {
    getRuntimeConfig: () => ({
      providers: [
        { providerId: "local", defaultModel: "small", baseUrl: "http://127.0.0.1:8080/v1", hasApiKey: false },
        { providerId: "cloud", defaultModel: "large", baseUrl: "https://api.example.com/v1", hasApiKey: true },
        { providerId: "keyless", defaultModel: "medium", baseUrl: "https://api.example.org/v1", hasApiKey: false },
        { providerId: "xai", defaultModel: "grok-3", baseUrl: "https://api.x.ai/v1", hasApiKey: true },
      ],
    }),
    getModelContextWindow: () => 32_768,
    getProviderRouteConfigFingerprint: () => "c".repeat(64),
    resolveExecutionApiStyle: () => "openai-chat-completions",
    admitsDispatchWard,
  } as unknown as ModelCouncilCandidateLlm;
  return { service, admitsDispatchWard };
}

describe("profile-free model council binding", () => {
  it("rechecks every member against readiness and the Citadel Ward as an Assembly participant", async () => {
    const { service, admitsDispatchWard } = llm(["cloud"]);
    const candidates = await selectModelCouncilCandidates(service, prepared(), { providerId: "local", model: "small" });
    expect(candidates.map((candidate) => candidate.providerId)).toEqual(["local"]);
    expect(admitsDispatchWard).toHaveBeenCalledWith(
      { callKind: "assembly_participant", workspaceId: "workspace-1", sessionId: "session-1", turnId: "turn-1" },
      "cloud",
    );
    expect(admitsDispatchWard).not.toHaveBeenCalledWith(expect.anything(), "keyless");
    expect(admitsDispatchWard).not.toHaveBeenCalledWith(expect.anything(), "xai");
  });

  it("carries the turn's route ward actions into every member recheck", async () => {
    const { service, admitsDispatchWard } = llm();
    await selectModelCouncilCandidates(
      service,
      prepared({ routeWardActions: ["model.chat.cloud", "model.chat.local"] } as Partial<PreparedAgentChatTurn>),
      { providerId: "local", model: "small" },
    );
    expect(admitsDispatchWard).toHaveBeenCalledWith(
      expect.objectContaining({ wardActions: ["model.chat.cloud", "model.chat.local"] }),
      "cloud",
    );
  });

  it("binds a new turn to its feature admission and marks a ward-refused primary not ready", async () => {
    const turn = prepared();
    expect(resolveModelCouncilPrimaryRoute(turn)).toEqual({ providerId: "local", model: "small" });
    const ready = resolveLiveModelCouncilBinding(
      turn,
      await selectModelCouncilCandidates(llm().service, turn, { providerId: "local", model: "small" }),
    );
    expect(ready).toEqual({
      bindingId: "feature-admission:admission-1",
      bindingHash: "b".repeat(64),
      turnId: "turn-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      primaryProviderId: "local",
      primaryModel: "small",
      thinkingLevel: "standard",
      primaryReady: true,
    });
    const refused = resolveLiveModelCouncilBinding(
      turn,
      await selectModelCouncilCandidates(llm(["local"]).service, turn, { providerId: "local", model: "small" }),
    );
    expect(refused.primaryReady).toBe(false);
  });

  it("refuses a live binding without an admitted council request", () => {
    const turn = prepared({
      featureAdmission: {
        references: {
          version: "chat.turn.feature-references.v1",
          providerRoute: { primary: { providerId: "local", model: "small" }, fingerprint: "a".repeat(64) },
        },
        referenceSha256: "b".repeat(64),
      },
    } as Partial<PreparedAgentChatTurn>);
    expect(() => resolveLiveModelCouncilBinding(turn, [])).toThrow(/admitted council request/);
  });
});
