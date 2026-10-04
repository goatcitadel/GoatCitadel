import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { providerChecks } from "./providers";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetchLlmConfig: vi.fn(),
  fetchLlmModels: vi.fn(),
  createLlmChatCompletion: vi.fn(),
  exerciseProvider: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: mocks.request }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({
  fetchLlmConfig: mocks.fetchLlmConfig,
  fetchLlmModels: mocks.fetchLlmModels,
  createLlmChatCompletion: mocks.createLlmChatCompletion,
}));
vi.mock("./dev-verification", () => ({ exerciseProvider: mocks.exerciseProvider }));

const CONFIG = {
  activeProviderId: "verification-stub",
  activeModel: "verification-stub-chat",
  providers: [{ providerId: "verification-stub" }],
  revision: 1,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.fetchLlmConfig.mockResolvedValue(CONFIG);
});

function run(id: string) {
  return findCheck(providerChecks, id).run(makeTestContext());
}

describe("provider checks", () => {
  it("lists configured providers and fails when there are none", async () => {
    mocks.request.mockResolvedValueOnce({ items: [{ providerId: "verification-stub" }] });
    await expect(run("llm.providers")).resolves.toMatchObject({
      status: "pass",
      summary: "1 provider(s): verification-stub.",
    });
    mocks.request.mockResolvedValueOnce({ items: [] });
    await expect(run("llm.providers")).rejects.toThrow("No providers are configured.");
  });

  it("requires the active provider to be in the provider list", async () => {
    await expect(run("llm.config")).resolves.toMatchObject({ status: "pass" });
    mocks.fetchLlmConfig.mockResolvedValueOnce({ ...CONFIG, providers: [] });
    await expect(run("llm.config")).rejects.toThrow("is not in the provider list");
  });

  it("sends a completion through the active provider", async () => {
    mocks.createLlmChatCompletion.mockResolvedValueOnce({
      choices: [{ index: 0, message: { content: "Verification stub reply." } }],
    });
    await expect(run("llm.completion")).resolves.toMatchObject({
      status: "pass",
      summary: expect.stringContaining("Verification stub reply."),
    });
    expect(mocks.createLlmChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "verification-stub", model: "verification-stub-chat" }),
    );
    mocks.createLlmChatCompletion.mockResolvedValueOnce({ choices: [] });
    await expect(run("llm.completion")).rejects.toThrow("empty completion");
  });

  it("requires a live model catalog", async () => {
    mocks.fetchLlmModels.mockResolvedValueOnce({ items: [{}, {}], source: "live" });
    await expect(run("llm.model-catalog")).resolves.toMatchObject({
      summary: "2 models listed live by verification-stub.",
    });
    mocks.fetchLlmModels.mockResolvedValueOnce({
      items: [],
      source: "template_fallback",
      warning: "Catalog unreachable.",
    });
    await expect(run("llm.model-catalog")).rejects.toThrow("template_fallback: Catalog unreachable.");
  });

  it("reports the provider exercise result and passes the run signal", async () => {
    mocks.exerciseProvider.mockResolvedValueOnce({ ok: true, model: "verification-stub-chat", elapsedMs: 12 });
    await expect(run("llm.provider-exercise")).resolves.toMatchObject({
      summary: "verification-stub-chat answered in 12 ms.",
    });
    expect(mocks.exerciseProvider).toHaveBeenCalledWith({ scenario: "simple" }, expect.any(AbortSignal));
    mocks.exerciseProvider.mockResolvedValueOnce({ ok: false, error: "401 from provider" });
    await expect(run("llm.provider-exercise")).rejects.toThrow("401 from provider");
  });

  it("allowlists only the network checks for the real gateway", () => {
    expect(providerChecks.filter((check) => check.realSafe === true).map((check) => check.id)).toEqual([
      "llm.model-catalog",
      "llm.provider-exercise",
    ]);
  });
});
