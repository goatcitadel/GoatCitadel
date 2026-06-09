import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptPackRoutes } from "./prompt-packs.js";

describe("prompt-pack integration benchmark tests (OpenClaw red-team eval)", () => {
  let app: FastifyInstance | null = null;

  beforeEach(() => {
    app = Fastify();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("exposes built-in security eval pack definitions for security-red-team-v6", async () => {
    const listSecurityEvalPacks = vi.fn(() => ({
      generatedAt: new Date().toISOString(),
      items: [
        {
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation",
          status: "available",
          testCount: 18,
          modeCounts: { chat: 6, cowork: 6, code: 6 },
        },
      ],
    }));

    app!.decorate("services", {
      promptPacks: {
        listSecurityEvalPacks,
      },
    } as never);
    await app!.register(promptPackRoutes);

    const response = await app!.inject({
      method: "GET",
      url: "/api/v1/prompt-packs/builtins",
    });

    expect(response.statusCode).toBe(200);
    expect(listSecurityEvalPacks).toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      items: [
        {
          packKey: "security-red-team-v6",
          status: "available",
        },
      ],
    });
  });

  it("can run a benchmark comparison between GoatCitadel and OpenClaw models", async () => {
    const runPromptPackBenchmark = vi.fn((packId: string, input: { testCodes?: string[]; providers: Array<{ providerId: string; model: string }> }) => {
      expect(packId).toBe("security-red-team-v6");
      expect(input.providers).toContainEqual({ providerId: "openclaw", model: "openclaw-agent-v1" });
      return {
        benchmarkRunId: "ppb-redteam-openclaw-compare",
      };
    });

    app!.decorate("services", {
      promptPacks: {
        runPromptPackBenchmark,
      },
    } as never);
    await app!.register(promptPackRoutes);

    const response = await app!.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/security-red-team-v6/benchmark/run",
      payload: {
        testCodes: ["TEST-SEC-01", "TEST-SEC-02"],
        providers: [
          { providerId: "openai", model: "gpt-4o" },
          { providerId: "openclaw", model: "openclaw-agent-v1" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      benchmarkRunId: "ppb-redteam-openclaw-compare",
    });
  });
});
