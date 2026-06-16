import { describe, it, expect, vi } from "vitest";
import { CitadelsRouteService, type CitadelsRoutePort } from "./citadels-route-service.js";

function repoStub(overrides: Partial<CitadelsRoutePort>): CitadelsRoutePort {
  return overrides as CitadelsRoutePort;
}

describe("CitadelsRouteService.interpretSessionMessage", () => {
  it("builds a prompt, strictly parses model output, and merges only valid fields", async () => {
    const session = { sessionId: "s1", answers: {}, status: "collecting" as const, createdAt: "t", updatedAt: "t" };
    const merged: Array<Record<string, unknown>> = [];
    const repo = repoStub({
      getMasonSession: vi.fn(() => session),
      updateMasonSessionAnswers: vi.fn((_id, patch) => {
        merged.push(patch as Record<string, unknown>);
        return { ...session, answers: patch };
      }),
    });
    const interpret = vi.fn(async (prompt: string) => {
      // The prompt carries the user's message.
      expect(prompt).toMatch(/I run a startup/);
      // Model output mixes valid fields with junk; the strict parser drops the junk.
      return 'Sure: {"kind":"company","purpose":"Run it","junk":"x","riskPosture":"bogus"}';
    });
    const service = new CitadelsRouteService(repo, interpret);

    const result = await service.interpretSessionMessage("s1", "I run a startup");

    expect(result.ok).toBe(true);
    expect(interpret).toHaveBeenCalledOnce();
    expect(merged[0]).toEqual({ kind: "company", purpose: "Run it" });
  });

  it("returns no_interpreter when no model is configured", async () => {
    const repo = repoStub({
      getMasonSession: vi.fn(() => ({ sessionId: "s1", answers: {}, status: "collecting", createdAt: "t", updatedAt: "t" })),
    });
    const service = new CitadelsRouteService(repo);

    expect(await service.interpretSessionMessage("s1", "hi")).toEqual({ ok: false, reason: "no_interpreter" });
  });

  it("returns not_found for a missing session", async () => {
    const repo = repoStub({ getMasonSession: vi.fn(() => undefined) });
    const service = new CitadelsRouteService(repo, async () => "{}");

    expect(await service.interpretSessionMessage("nope", "hi")).toEqual({ ok: false, reason: "not_found" });
  });
});
