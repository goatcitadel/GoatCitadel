import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { promptPackRoutes } from "./prompt-packs.js";

describe("prompt-pack routes", () => {
  it("awaits Promise-native prompt-pack list results before wrapping them as items", async () => {
    const listPromptPacks = vi.fn(async () => [
      {
        packId: "pack-async",
        name: "Async pack",
        sourceLabel: "test",
        testCount: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    ]);
    const app = Fastify();
    app.decorate("services", { promptPacks: { listPromptPacks } } as never);
    await app.register(promptPackRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/prompt-packs?limit=20" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ packId: "pack-async" }] });
    expect(listPromptPacks).toHaveBeenCalledWith(20);
    await app.close();
  });

  it("previews Promptfoo imports and exports Promptfoo records without changing default export", async () => {
    const previewPromptPackImport = vi.fn(() => ({
      valid: true,
      format: "promptfoo",
      generatedAt: "2026-06-02T00:00:00.000Z",
      testCount: 1,
      promptCount: 1,
      providerCount: 0,
      warnings: [],
      errors: [],
      posture: {
        readOnly: true,
        sideEffectPosture: "preview_only",
        callsProviders: false,
        mutationPerformed: false,
        note: "preview only",
      },
    }));
    const getPromptPackExport = vi.fn((packId: string, format?: string) => ({
      packId,
      format: format ?? "goatcitadel",
      path: "reports/prompt-packs/export.json",
      exists: true,
      sizeBytes: 2,
    }));
    const exportPromptPack = vi.fn((packId: string, input?: { format?: string }) => ({
      packId,
      format: input?.format ?? "goatcitadel",
      path: "reports/prompt-packs/export.json",
      exists: true,
      sizeBytes: 2,
    }));
    const app = Fastify();
    app.decorate("services", {
      promptPacks: {
        previewPromptPackImport,
        getPromptPackExport,
        exportPromptPack,
      },
    } as never);
    await app.register(promptPackRoutes);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/import/preview",
      payload: { content: "prompts:\n  - '{{prompt}}'\ntests:\n  - vars: {}", format: "promptfoo" },
    });
    const fetched = await app.inject({
      method: "GET",
      url: "/api/v1/prompt-packs/pack%2F1/export?format=promptfoo",
    });
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/pack%2F1/export",
      payload: { format: "promptfoo" },
    });

    expect(preview.statusCode).toBe(200);
    expect(previewPromptPackImport).toHaveBeenCalledWith({
      content: "prompts:\n  - '{{prompt}}'\ntests:\n  - vars: {}",
      format: "promptfoo",
    });
    expect(fetched.statusCode).toBe(200);
    expect(getPromptPackExport).toHaveBeenCalledWith("pack/1", "promptfoo");
    expect(refreshed.statusCode).toBe(200);
    expect(exportPromptPack).toHaveBeenCalledWith("pack/1", { format: "promptfoo" });
    expect(refreshed.json()).toMatchObject({ format: "promptfoo" });
  });

  it("exposes built-in security eval packs and imports them only on explicit request", async () => {
    const listSecurityEvalPacks = vi.fn(() => ({
      generatedAt: "2026-05-30T00:00:00.000Z",
      items: [
        {
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation",
          sourceLabel: "goatcitadel_prompt_pack_v6_security_red_team.md",
          status: "available",
          testCount: 18,
          modeCounts: { chat: 6, cowork: 6, code: 6 },
          toolTierCounts: { "no-tools": 6, "implicit-tools": 6, "explicit-tools": 6 },
          capabilityTargets: ["tool-governance"],
          likelyFailureClasses: ["unsafe_tool_use"],
          safetyPosture: {
            definitionOnly: true,
            requiresOperatorRun: true,
            callsProviders: false,
            mutationPerformed: false,
            note: "catalog only",
          },
          blockers: ["Import this prompt pack before it can produce run, score, or benchmark evidence."],
        },
      ],
      warnings: ["This projection does not call providers or run tests."],
    }));
    const listSecurityQualityGates = vi.fn(() => ({
      generatedAt: "2026-05-30T00:00:00.000Z",
      items: [
        {
          gateId: "prompt-pack:security-red-team-v6:security-quality",
          packKey: "security-red-team-v6",
          title: "Defensive Security Evaluation gate",
          status: "not_imported",
          releaseGate: true,
          readOnly: true,
          generatedAt: "2026-05-30T00:00:00.000Z",
          evidence: {
            definitionStatus: "available",
            testCount: 18,
            completedRuns: 0,
            failedRuns: 0,
            needsScoreCount: 18,
            passCount: 0,
            failCount: 0,
            reviewCount: 0,
            effectivePassRate: 0,
            passThreshold: 75,
            failingCodes: [],
          },
          blockers: ["Import the defensive security prompt pack before running the gate."],
          nextActions: ["Import the defensive security prompt pack from Ops Quality or Library Prompt Packs."],
          posture: {
            callsProviders: false,
            mutationPerformed: false,
            source: "stored_prompt_pack_report",
            note: "stored evidence only",
          },
        },
      ],
      warnings: ["Security quality gates are read-only projections from stored prompt-pack reports."],
    }));
    const importBuiltinPromptPack = vi.fn((packKey: string) => ({
      pack: {
        packId: packKey,
        name: "Defensive Security Evaluation",
        testCount: 18,
        createdAt: "2026-05-30T00:00:00.000Z",
        updatedAt: "2026-05-30T00:00:00.000Z",
      },
      tests: [],
    }));
    const app = Fastify();
    app.decorate("services", {
      promptPacks: {
        listSecurityEvalPacks,
        listSecurityQualityGates,
        importBuiltinPromptPack,
      },
    } as never);
    await app.register(promptPackRoutes);

    const builtins = await app.inject({ method: "GET", url: "/api/v1/prompt-packs/builtins" });
    const gates = await app.inject({ method: "GET", url: "/api/v1/prompt-packs/security-gates" });
    const imported = await app.inject({
      method: "POST",
      url: "/api/v1/prompt-packs/builtins/security-red-team-v6/import",
    });

    expect(builtins.statusCode).toBe(200);
    expect(builtins.json()).toMatchObject({
      items: [
        {
          packKey: "security-red-team-v6",
          safetyPosture: { definitionOnly: true, callsProviders: false, mutationPerformed: false },
        },
      ],
    });
    expect(listSecurityEvalPacks).toHaveBeenCalledTimes(1);
    expect(gates.statusCode).toBe(200);
    expect(gates.json()).toMatchObject({
      items: [
        {
          gateId: "prompt-pack:security-red-team-v6:security-quality",
          status: "not_imported",
          readOnly: true,
          posture: { callsProviders: false, mutationPerformed: false },
        },
      ],
    });
    expect(listSecurityQualityGates).toHaveBeenCalledTimes(1);
    expect(imported.statusCode).toBe(200);
    expect(importBuiltinPromptPack).toHaveBeenCalledWith("security-red-team-v6");
  });
});
