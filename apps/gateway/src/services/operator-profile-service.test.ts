import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { OperatorProfileFact } from "@goatcitadel/contracts";
import { OperatorProfileService } from "./operator-profile-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createStorage(): Promise<Storage> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-operator-profile-svc-"));
  tempRoots.push(rootDir);
  return new Storage({
    dbPath: path.join(rootDir, "runtime.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
}

function createService(
  storage: Storage,
  options: { autonomyDisabled?: boolean } = {},
): OperatorProfileService {
  return new OperatorProfileService({
    storage,
    isFeatureEnabled: (flag) => (flag === "autonomyV1Disabled" ? Boolean(options.autonomyDisabled) : false),
  });
}

describe("OperatorProfileService.ensureOperatorProfile", () => {
  it("creates a profile and stamps WorkspacePrefs.operatorProfileId on first use", async () => {
    const storage = await createStorage();
    const workspace = storage.workspaces.create({ name: "Acme" });
    expect(workspace.workspacePrefs?.operatorProfileId).toBeUndefined();

    const service = createService(storage);
    const profile = service.ensureOperatorProfile(workspace.workspaceId);

    expect(profile.operatorProfileId).toMatch(/^op_/);
    expect(profile.workspaceId).toBe(workspace.workspaceId);
    expect(profile.revision).toBe(1);

    // The id is now persisted onto the workspace prefs.
    const reloaded = storage.workspaces.get(workspace.workspaceId);
    expect(reloaded.workspacePrefs?.operatorProfileId).toBe(profile.operatorProfileId);

    // Idempotent: a second ensure returns the same profile without re-stamping.
    const again = service.ensureOperatorProfile(workspace.workspaceId);
    expect(again.operatorProfileId).toBe(profile.operatorProfileId);
    expect(again.revision).toBe(1);
  });

  it("works without a workspace record (default fallback), keyed by workspaceId", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    const profile = service.ensureOperatorProfile("default");
    expect(profile.workspaceId).toBe("default");
    expect(storage.operatorProfiles.getByWorkspace("default")?.operatorProfileId).toBe(profile.operatorProfileId);
  });
});

describe("OperatorProfileService.recordOperatorProfileFacts", () => {
  const facts: OperatorProfileFact[] = [
    { kind: "preference", content: "Prefers metric units.", confidence: 0.9 },
    { kind: "goal", content: "Ship GoatCitadel v1.", confidence: 0.8 },
  ];

  it("auto-applies agent-proposed facts under full autonomy, snapshotting the prior revision", async () => {
    const storage = await createStorage();
    const service = createService(storage, { autonomyDisabled: false });

    const result = service.recordOperatorProfileFacts("default", { facts });
    expect(result.outcome).toBe("applied");
    expect(result.record.facts).toHaveLength(2);
    // Prior snapshot is the empty profile created by ensure (revision 1).
    expect(result.priorSnapshot?.revision).toBe(1);
    expect(result.record.revision).toBe(2);

    const stored = storage.operatorProfiles.getByWorkspace("default");
    expect(stored?.facts.map((fact) => fact.content)).toContain("Prefers metric units.");
  });

  it("keeps agent-proposed facts as proposed (not persisted) when autonomy is off", async () => {
    const storage = await createStorage();
    const service = createService(storage, { autonomyDisabled: true });

    const result = service.recordOperatorProfileFacts("default", { facts });
    expect(result.outcome).toBe("proposed");
    expect(result.proposedFacts).toHaveLength(2);

    // Nothing was persisted beyond the empty ensure-created profile.
    const stored = storage.operatorProfiles.getByWorkspace("default");
    expect(stored?.facts).toHaveLength(0);
    expect(stored?.revision).toBe(1);
  });

  it("always applies trusted/operator authority writes regardless of autonomy", async () => {
    const storage = await createStorage();
    const service = createService(storage, { autonomyDisabled: true });

    const result = service.recordOperatorProfileFacts("default", { facts, authority: "operator" });
    expect(result.outcome).toBe("applied");
    expect(result.record.facts).toHaveLength(2);
  });

  it("blocks secret-like facts even under full autonomy", async () => {
    const storage = await createStorage();
    const service = createService(storage, { autonomyDisabled: false });

    const result = service.recordOperatorProfileFacts("default", {
      facts: [
        { kind: "fact", content: "Prefers dark mode.", confidence: 0.7 },
        { kind: "fact", content: "API key is sk-abcdef0123456789abcdef.", confidence: 0.9 },
      ],
      authority: "operator",
    });

    expect(result.blockedFacts).toHaveLength(1);
    expect(result.record.facts.map((fact) => fact.content)).toEqual(["Prefers dark mode."]);
    expect(JSON.stringify(result.record)).not.toContain("sk-abcdef");
  });
});

describe("OperatorProfileService.composeFrozenProfileDigest", () => {
  it("returns undefined when there is nothing to inject", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    service.ensureOperatorProfile("default");
    expect(service.composeFrozenProfileDigest("default")).toBeUndefined();
  });

  it("renders a bounded USER.md-style block grouped by kind, with secrets stripped", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    service.setOperatorProfileSummary("default", "Founder who prefers terse, source-grounded answers.");
    service.recordOperatorProfileFacts("default", {
      authority: "operator",
      facts: [
        { kind: "preference", content: "Prefers metric units.", confidence: 0.9 },
        { kind: "constraint", content: "Never email vendors without approval.", confidence: 1 },
        { kind: "goal", content: "Ship v1 by Q3.", confidence: 0.85 },
      ],
    });

    const digest = service.composeFrozenProfileDigest("default");
    expect(digest).toBeDefined();
    expect(digest).toContain("Operator profile");
    expect(digest).toContain("Founder who prefers terse");
    expect(digest).toContain("Preferences:");
    expect(digest).toContain("- Prefers metric units.");
    expect(digest).toContain("Constraints:");
    expect(digest).toContain("Goals:");
  });

  it("is byte-stable across calls at the same revision and changes when the profile changes (cache key = revision)", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    service.recordOperatorProfileFacts("default", {
      authority: "operator",
      facts: [{ kind: "preference", content: "Prefers metric units.", confidence: 0.9 }],
    });

    const first = service.composeFrozenProfileDigest("default");
    const second = service.composeFrozenProfileDigest("default");
    expect(first).toBe(second);

    // A new write bumps the revision and busts the cache.
    service.recordOperatorProfileFacts("default", {
      authority: "operator",
      facts: [{ kind: "goal", content: "Ship v1.", confidence: 0.8 }],
    });
    const third = service.composeFrozenProfileDigest("default");
    expect(third).not.toBe(first);
    expect(third).toContain("Goals:");
  });

  it("strips a secret that somehow landed in a stored summary before rendering", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    const profile = service.ensureOperatorProfile("default");
    // Simulate a tainted summary written directly to storage (defense in depth).
    storage.operatorProfiles.upsert({
      operatorProfileId: profile.operatorProfileId,
      workspaceId: "default",
      summary: "password=hunter2 is the operator login.",
      facts: [{ kind: "preference", content: "Prefers metric units.", confidence: 0.9 }],
    });
    const digest = service.composeFrozenProfileDigest("default");
    expect(digest).toBeDefined();
    expect(digest).not.toContain("hunter2");
    expect(digest).toContain("Prefers metric units.");
  });
});

describe("OperatorProfileService.restoreOperatorProfileSnapshot", () => {
  it("restores a captured snapshot and re-bumps the revision", async () => {
    const storage = await createStorage();
    const service = createService(storage);
    service.recordOperatorProfileFacts("default", {
      authority: "operator",
      facts: [{ kind: "preference", content: "Original preference.", confidence: 0.9 }],
    });
    const write = service.recordOperatorProfileFacts("default", {
      authority: "operator",
      facts: [{ kind: "goal", content: "New goal.", confidence: 0.8 }],
    });
    expect(write.priorSnapshot).toBeDefined();

    const restored = service.restoreOperatorProfileSnapshot(write.priorSnapshot!);
    expect(restored.facts.map((fact) => fact.content)).toEqual(["Original preference."]);
    expect(restored.revision).toBeGreaterThan(write.record.revision);
  });
});
