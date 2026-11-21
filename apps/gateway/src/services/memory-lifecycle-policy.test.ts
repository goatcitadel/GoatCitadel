import { describe, expect, it } from "vitest";
import {
  clampMemoryConfidence,
  computeMemoryLifecycleTextOverlap,
  decideLearnedMemoryWrite,
  DEFAULT_MEMORY_WORKSPACE_ID,
  matchesMemoryWorkspaceScope,
  normalizeMemoryLifecycleText,
  shouldSuppressMaintenanceRecommendation,
} from "./memory-lifecycle-policy.js";

describe("memory-lifecycle-policy", () => {
  it("keeps an opposite scalar preference inactive until an exact correction is reviewed", () => {
    const identity = {
      subject: "operator",
      predicate: "reply_length",
      scope: { kind: "workspace" as const, id: "A" },
      cardinality: "scalar" as const,
    };
    expect(
      decideLearnedMemoryWrite({
        workspaceId: "A",
        claim: { identity, value: "detailed" },
        authority: "agent_proposed",
        content: "I prefer detailed replies",
        confidence: 0.99,
        existing: [
          {
            itemId: "reply",
            content: "I prefer concise replies",
            confidence: 0.8,
            claim: { identity, value: "concise" },
            sourceHash: "one",
          },
        ],
      }),
    ).toEqual({ action: "record_conflict", existingItemId: "reply", incomingConfidence: 0.99 });
  });

  it("keeps unrelated properties independent even when their coarse type and confidence match", () => {
    expect(
      decideLearnedMemoryWrite({
        content: "I prefer concise replies",
        confidence: 0.8,
        existing: [{ itemId: "language", content: "I prefer TypeScript", confidence: 0.8 }],
      }),
    ).toEqual({ action: "insert_active", incomingConfidence: 0.8 });
  });

  it("never replaces an unrelated fact just because a model gives it greater confidence", () => {
    expect(
      decideLearnedMemoryWrite({
        content: "Use detailed explanations",
        confidence: 0.99,
        existing: [{ itemId: "language", content: "Prefer TypeScript", confidence: 0.4 }],
      }),
    ).toEqual({ action: "insert_active", incomingConfidence: 0.99 });
  });

  it("normalizes and clamps lifecycle inputs consistently", () => {
    expect(clampMemoryConfidence(1.5)).toBe(1);
    expect(clampMemoryConfidence(-0.5)).toBe(0);
    expect(normalizeMemoryLifecycleText("  **Hello**   World  ")).toBe("hello world");
    expect(computeMemoryLifecycleTextOverlap("alpha beta gamma", "alpha beta delta")).toBeCloseTo(2 / 3);
  });

  it("merges exact learned-memory duplicates", () => {
    expect(
      decideLearnedMemoryWrite({
        content: "Prefers TypeScript over JavaScript",
        confidence: 0.4,
        existing: [
          {
            itemId: "item-1",
            content: "prefers typescript over javascript",
            confidence: 0.8,
          },
        ],
      }),
    ).toEqual({
      action: "merge_duplicate",
      itemId: "item-1",
      nextConfidence: 0.8,
    });
  });

  it("does not infer a conflict between unbound legacy properties at similar confidence", () => {
    expect(
      decideLearnedMemoryWrite({
        content: "Prefers shipping broad rewrites quickly",
        confidence: 0.62,
        existing: [
          {
            itemId: "item-1",
            content: "Prefers surgical diffs and careful rollout",
            confidence: 0.58,
          },
        ],
      }),
    ).toEqual({
      action: "insert_active",
      incomingConfidence: 0.62,
    });
  });

  it("does not infer supersession of an unbound legacy property from confidence", () => {
    expect(
      decideLearnedMemoryWrite({
        content: "Needs approvals before touching production systems",
        confidence: 0.92,
        existing: [
          {
            itemId: "item-1",
            content: "Likes improvising without review in playground experiments",
            confidence: 0.41,
          },
        ],
      }),
    ).toEqual({
      action: "insert_active",
      incomingConfidence: 0.92,
    });
  });

  it("gives canonical workspace scope precedence over legacy metadata", () => {
    const normalizeWorkspaceId = (workspaceId?: string) => workspaceId?.trim() || DEFAULT_MEMORY_WORKSPACE_ID;
    const canonical = {
      namespace: "shared.preferences",
      workspaceId: "workspace-a",
      metadata: { workspaceId: "workspace-b" },
    } as never;

    expect(matchesMemoryWorkspaceScope(canonical, "workspace-a", normalizeWorkspaceId)).toBe(true);
    expect(matchesMemoryWorkspaceScope(canonical, "workspace-b", normalizeWorkspaceId)).toBe(false);
    expect(matchesMemoryWorkspaceScope(canonical, "default", normalizeWorkspaceId)).toBe(false);
    expect(
      matchesMemoryWorkspaceScope(
        { ...canonical, workspaceId: " workspace-a " } as never,
        "workspace-a",
        normalizeWorkspaceId,
      ),
    ).toBe(false);
  });

  it("keeps legacy metadata scope isolated while treating genuinely unscoped items as global", () => {
    const normalizeWorkspaceId = (workspaceId?: string) => workspaceId?.trim() || DEFAULT_MEMORY_WORKSPACE_ID;
    const legacy = {
      namespace: "shared.preferences",
      metadata: { workspaceId: " workspace-a " },
    } as never;
    const global = {
      namespace: "shared.preferences",
      metadata: {},
    } as never;
    const blankLegacy = {
      namespace: "shared.preferences",
      metadata: { workspaceId: "   " },
    } as never;
    const nonStringLegacy = {
      namespace: "shared.preferences",
      metadata: { workspaceId: 42 },
    } as never;

    expect(matchesMemoryWorkspaceScope(legacy, "workspace-a", normalizeWorkspaceId)).toBe(true);
    expect(matchesMemoryWorkspaceScope(legacy, "workspace-b", normalizeWorkspaceId)).toBe(false);
    expect(matchesMemoryWorkspaceScope(global, "workspace-a", normalizeWorkspaceId)).toBe(true);
    expect(matchesMemoryWorkspaceScope(global, "workspace-b", normalizeWorkspaceId)).toBe(true);
    expect(matchesMemoryWorkspaceScope(blankLegacy, "workspace-a", normalizeWorkspaceId)).toBe(true);
    expect(matchesMemoryWorkspaceScope(nonStringLegacy, "workspace-a", normalizeWorkspaceId)).toBe(true);
  });

  it("suppresses duplicate maintenance recommendations inside the active window", () => {
    expect(
      shouldSuppressMaintenanceRecommendation({
        kind: "model_adjustment",
        proposedPatch: {
          providerId: "openai",
          model: "gpt-5.4-mini",
        },
        now: Date.parse("2026-04-10T12:00:00.000Z"),
        existing: [
          {
            recommendationId: "rec-1",
            workspaceId: "default",
            kind: "model_adjustment",
            status: "queued",
            summary: "Try a different model",
            proposedPatch: {
              providerId: "openai",
              model: "gpt-5.4-mini",
            },
            createdAt: "2026-04-10T05:00:00.000Z",
            updatedAt: "2026-04-10T08:00:00.000Z",
          },
        ] as never,
      }),
    ).toBe(true);

    expect(
      shouldSuppressMaintenanceRecommendation({
        kind: "model_adjustment",
        proposedPatch: {
          providerId: "openai",
          model: "gpt-5.4-mini",
        },
        now: Date.parse("2026-04-11T12:00:00.000Z"),
        existing: [
          {
            recommendationId: "rec-1",
            workspaceId: "default",
            kind: "model_adjustment",
            status: "queued",
            summary: "Try a different model",
            proposedPatch: {
              providerId: "openai",
              model: "gpt-5.4-mini",
            },
            createdAt: "2026-04-10T05:00:00.000Z",
            updatedAt: "2026-04-10T08:00:00.000Z",
          },
        ] as never,
      }),
    ).toBe(false);
  });
});
