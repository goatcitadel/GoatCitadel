import { describe, it, expect, vi } from "vitest";
import type { CitadelVaultSecretRecord } from "@goatcitadel/contracts";
import { generateVaultKey } from "@goatcitadel/contracts/citadel-vault-node";
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
      getMasonSession: vi.fn(() => ({
        sessionId: "s1",
        answers: {},
        status: "collecting",
        createdAt: "t",
        updatedAt: "t",
      })),
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

describe("CitadelsRouteService vault", () => {
  it("seals on store and opens on reveal, never exposing the value on store or list", async () => {
    const key = generateVaultKey();
    const store = new Map<string, CitadelVaultSecretRecord>();
    let lastSealed: unknown;
    const repo = repoStub({
      storeVaultSecret: vi.fn((input) => {
        lastSealed = input.sealedValue;
        const record: CitadelVaultSecretRecord = {
          secretId: "s1",
          citadelId: input.citadelId,
          secretName: input.secretName,
          sealedValue: input.sealedValue,
          createdAt: "t",
          updatedAt: "t",
        };
        store.set("s1", record);
        return record;
      }),
      getVaultSecret: vi.fn((_cid: string, sid: string) => store.get(sid)),
      listVaultSecrets: vi.fn(() => [...store.values()]),
    });
    const service = new CitadelsRouteService(repo, undefined, () => key);

    const stored = await service.storeVaultSecret("c1", "stripe", "sk-live-SECRET-123");
    expect(stored).toEqual({
      ok: true,
      secret: { secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" },
    });
    // The persisted envelope is ciphertext, not the plaintext.
    expect(JSON.stringify(lastSealed)).not.toContain("sk-live-SECRET-123");

    await expect(service.revealVaultSecret("c1", "s1")).resolves.toEqual({ ok: true, value: "sk-live-SECRET-123" });

    // The list view carries names + provenance only — never the sealed or opened value.
    await expect(service.listVaultSecrets("c1")).resolves.toEqual([
      { secretId: "s1", secretName: "stripe", createdAt: "t", updatedAt: "t" },
    ]);
  });

  it("fails closed (unavailable) when no vault key is configured", async () => {
    const service = new CitadelsRouteService(repoStub({}));
    await expect(service.storeVaultSecret("c1", "k", "v")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(service.revealVaultSecret("c1", "s1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns not_found when revealing a missing secret", async () => {
    const key = generateVaultKey();
    const repo = repoStub({ getVaultSecret: vi.fn(() => undefined) });
    const service = new CitadelsRouteService(repo, undefined, () => key);
    await expect(service.revealVaultSecret("c1", "nope")).resolves.toEqual({ ok: false, reason: "not_found" });
  });
});
