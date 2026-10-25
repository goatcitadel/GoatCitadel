import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHIPPED_SKILL_PACKS } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { NodeSkillHubArtifactFilesystem, SkillHubArtifactStore } from "./skill-hub-artifact-store.js";
import {
  NodeSkillHubWindowsSecurity,
  PowerShellSkillHubWindowsSecurityProtocol,
} from "./skill-hub-windows-security.js";
import { SkillHubReviewService } from "./skill-hub-review-service.js";
import { SkillImportService } from "./skill-import-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const packRoot = path.join(repoRoot, "skills", "import-packs");

let rootDir: string;
let storage: Storage;
let windowsSecurity: PowerShellSkillHubWindowsSecurityProtocol | undefined;
let service: SkillHubReviewService;

beforeAll(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-skill-packs-"));
  storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  windowsSecurity =
    process.platform === "win32"
      ? new PowerShellSkillHubWindowsSecurityProtocol({ idleShutdownMs: Number.POSITIVE_INFINITY })
      : undefined;
  const settings = new Map<string, unknown>();
  service = new SkillHubReviewService({
    storage: createSqliteAsyncStorage(storage),
    artifactStore: new SkillHubArtifactStore(path.join(rootDir, "artifacts"), {
      filesystem: new NodeSkillHubArtifactFilesystem(
        windowsSecurity ? { windowsSecurity: new NodeSkillHubWindowsSecurity(windowsSecurity) } : {},
      ),
    }),
    skillImport: new SkillImportService(repoRoot, {
      get: async <T>(key: string) => settings.get(key) as T | undefined,
      set: async (key: string, value: unknown) => {
        settings.set(key, value);
      },
    } as ConstructorParameters<typeof SkillImportService>[1]),
    shippedSkillPackRoot: packRoot,
  });
}, 180_000); // One full SQLite migration replay.

afterAll(async () => {
  windowsSecurity?.dispose();
  storage?.close();
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("shipped skill packs", { timeout: 120_000 }, () => {
  it("ships one directory with a SKILL.md, licence and provenance note for every listed pack", async () => {
    const directories = (await fs.readdir(packRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(SHIPPED_SKILL_PACKS.map((pack) => pack.packId).sort());
    for (const pack of SHIPPED_SKILL_PACKS) {
      for (const file of ["SKILL.md", "LICENSE", "UPSTREAM.md"]) {
        await expect(fs.stat(path.join(packRoot, pack.packId, file))).resolves.toBeTruthy();
      }
    }
  });

  it.each(SHIPPED_SKILL_PACKS.map((pack) => [pack.packId] as const))(
    "%s passes production Skill Hub review as an inactive candidate",
    async (packId) => {
      const reviewed = await service.reviewSource({
        workspaceId: "workspace-1",
        packId,
        idempotencyKey: `pack-review-${packId}`,
        actorId: "operator:alice",
      });
      expect(reviewed.snapshot).toMatchObject({
        operation: "review",
        sourceType: "local_path",
        sourceRef: path.join(path.resolve(packRoot), packId),
        trustDisposition: "candidate",
        blockerCodes: [],
      });
      expect(reviewed.snapshot.permissionEnvelope).toMatchObject({
        toolIds: expect.arrayContaining(["tool:shell.exec"]),
        scripts: [],
      });
    },
  );

  it("rejects unknown packs, mixed sources and a Gateway without a pack root", async () => {
    await expect(
      service.reviewSource({ workspaceId: "w", packId: "../bundled", idempotencyKey: "k1", actorId: "operator:alice" }),
    ).rejects.toThrow("Unknown shipped skill pack.");
    await expect(
      service.reviewSource({ workspaceId: "w", packId: "gog", idempotencyKey: "k0", actorId: "operator:alice" }),
    ).rejects.toThrow("Unknown shipped skill pack.");
    await expect(
      service.reviewSource({
        workspaceId: "w",
        packId: "himalaya",
        sourceRef: "https://github.com/example/skill",
        idempotencyKey: "k2",
        actorId: "operator:alice",
      }),
    ).rejects.toThrow("not both");
    const withoutRoot = new SkillHubReviewService({
      storage: createSqliteAsyncStorage(storage),
      artifactStore: new SkillHubArtifactStore(path.join(rootDir, "artifacts-2")),
      skillImport: { withMaterializedValidation: async () => Promise.reject(new Error("unreachable")) },
    });
    await expect(
      withoutRoot.reviewSource({
        workspaceId: "w",
        packId: "himalaya",
        idempotencyKey: "k3",
        actorId: "operator:alice",
      }),
    ).rejects.toThrow("not available in this Gateway");
  });
});
