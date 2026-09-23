import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { listWorkspaceCandidateSkills } from "./candidate-skill-catalog-service.js";

const load = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
vi.mock("./candidate-runtime-skills.js", () => ({ loadApprovedCandidateSkill: load }));
vi.mock("@goatcitadel/gateway-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@goatcitadel/gateway-core")>();
  return { ...actual, logger: { ...actual.logger, warn } };
});

function fixture() {
  const version = { versionId: "version-a" };
  const lifecycle = {
    skillId: "candidate-a",
    category: "candidate",
    lifecycleState: "approved",
    trustLabel: "reviewed",
    provenance: { workspaceId: "workspace-a" },
  };
  const loaded = { skill: { skillId: "candidate-a" }, lifecycle };
  const storage = {
    candidateSkillVersions: { listApprovedInstructions: vi.fn(async () => [version]) },
    skillLifecycle: { find: vi.fn(async () => lifecycle), upsert: vi.fn() },
    skillAggregateRevisions: { ensure: vi.fn(async () => ({ revision: 3 })) },
  };
  const deps = { storage, rootDir: "fixture-root" } as unknown as Parameters<typeof listWorkspaceCandidateSkills>[0];
  load.mockResolvedValue(loaded);
  return { deps, storage, version, lifecycle, loaded };
}

describe("candidate skill catalog projection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("binds approved instruction loading to the requested workspace and preserves matching projections", async () => {
    const f = fixture();
    const result = await listWorkspaceCandidateSkills(f.deps, "candidate-root", "workspace-a", new Map());
    expect(f.storage.candidateSkillVersions.listApprovedInstructions).toHaveBeenCalledWith("workspace-a", 200);
    expect(load).toHaveBeenCalledWith({
      rootDir: "fixture-root",
      candidateRoot: "candidate-root",
      version: f.version,
      workspaceId: "workspace-a",
    });
    expect(result).toMatchObject([{ skillId: "candidate-a", revision: 3, callable: true }]);
    expect(f.storage.skillLifecycle.upsert).not.toHaveBeenCalled();
  });

  it("omits rejected artifact loads without projecting lifecycle or revision state", async () => {
    const f = fixture();
    load.mockResolvedValue(undefined);
    expect(await listWorkspaceCandidateSkills(f.deps, "candidate-root", "workspace-a", new Map())).toEqual([]);
    expect(f.storage.skillLifecycle.find).not.toHaveBeenCalled();
    expect(f.storage.skillLifecycle.upsert).not.toHaveBeenCalled();
    expect(f.storage.skillAggregateRevisions.ensure).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a bundle changed after review",
      new ConflictError({ message: "Approved skill bundle changed after artifact review." }),
      "Approved skill bundle changed after artifact review.",
    ],
    [
      "a deleted bundle file",
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
      "ENOENT",
    ],
  ])("quarantines %s without failing the rest of the workspace catalog", async (_label, failure, reason) => {
    const f = fixture();
    const broken = { versionId: "version-broken", candidateId: "candidate-broken" };
    f.storage.candidateSkillVersions.listApprovedInstructions.mockResolvedValue([broken, f.version]);
    load.mockImplementation(async ({ version }: { version: unknown }) => {
      if (version === broken) throw failure;
      return f.loaded;
    });
    const result = await listWorkspaceCandidateSkills(f.deps, "candidate-root", "workspace-a", new Map());
    expect(result).toMatchObject([{ skillId: "candidate-a", callable: true }]);
    expect(result).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Quarantined"), {
      workspaceId: "workspace-a",
      candidateId: "candidate-broken",
      versionId: "version-broken",
      reason,
    });
  });

  it("preserves disabled state and its existing revision while repairing stale lifecycle projection", async () => {
    const f = fixture();
    f.storage.skillLifecycle.find.mockResolvedValue({ ...f.lifecycle, trustLabel: "stale" });
    const states = new Map([
      ["candidate-a", { state: "disabled", revision: 8, pinned: true }],
    ]) as unknown as Parameters<typeof listWorkspaceCandidateSkills>[3];
    const result = await listWorkspaceCandidateSkills(f.deps, "candidate-root", "workspace-a", states);
    expect(result).toMatchObject([{ state: "disabled", revision: 8, pinned: true, callable: false }]);
    expect(f.storage.skillLifecycle.upsert).toHaveBeenCalledWith(f.lifecycle);
    expect(f.storage.skillAggregateRevisions.ensure).not.toHaveBeenCalled();
  });
});
