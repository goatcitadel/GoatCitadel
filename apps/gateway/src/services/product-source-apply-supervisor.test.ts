import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { ManagedSourceInstallRecord, ProductSourceUpdateManifestRecord } from "@goatcitadel/storage";
import { ProductSourceApplySupervisor } from "./product-source-apply-supervisor.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("ProductSourceApplySupervisor", () => {
  it("fails closed when the pinned native helper is unavailable", async () => {
    const fixture = await createFixture();
    const supervisor = new ProductSourceApplySupervisor({
      rootDir: fixture.root,
      sourceOwner: fixture.sourceOwner,
      platform: "win32",
    });
    await expect(
      supervisor.launchApply({ plan: fixture.plan, manifest: fixture.manifest, approvalIds: ["approval-1"] }),
    ).resolves.toEqual({ status: "failed", failureCode: "native_helper_unavailable" });
  });

  it("pins helper identity, writes a private immutable request, and accepts a bound result", async () => {
    const fixture = await createFixture();
    const helperPath = path.join(fixture.root, "native", "source-update-helper.exe");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "verified helper bytes", "utf8");
    const helperSha256 = sha256("verified helper bytes");
    const launchHelper = vi.fn(async (_helperPath: string, args: readonly string[]) => {
      const requestPath = args[args.indexOf("--request") + 1]!;
      const requestSha256 = args[args.indexOf("--request-sha256") + 1]!;
      const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as {
        resultPath: string;
        manifestId: string;
        operation: string;
      };
      await fs.writeFile(
        request.resultPath,
        JSON.stringify({
          schemaVersion: 1,
          operation: request.operation,
          manifestId: request.manifestId,
          requestSha256,
          status: "succeeded",
          baselineSha: "8".repeat(40),
          baselineTree: "9".repeat(40),
          evidenceSha256: "a".repeat(64),
          finishedAt: new Date().toISOString(),
        }),
        "utf8",
      );
    });
    const supervisor = new ProductSourceApplySupervisor({
      rootDir: fixture.root,
      sourceOwner: fixture.sourceOwner,
      helperPath,
      helperSha256,
      restart: {
        executable: path.join(fixture.root, "node.exe"),
        args: ["gateway.js"],
        workingDirectory: fixture.sourceRoot,
        healthUrl: "http://127.0.0.1:8787/health",
      },
      platform: "win32",
      parentPid: 1234,
      launchHelper,
    });
    const launched = await supervisor.launchApply({
      plan: fixture.plan,
      manifest: fixture.manifest,
      approvalIds: ["approval-1"],
    });
    expect(launched).toMatchObject({ status: "running" });
    expect(launchHelper).toHaveBeenCalledOnce();
    const observed = await supervisor.inspect(fixture.manifest);
    expect(observed).toMatchObject({ status: "succeeded", baselineSha: "8".repeat(40), baselineTree: "9".repeat(40) });
    expect(JSON.stringify(observed)).not.toContain(fixture.sourceRoot);
  });

  it("rejects helper identity drift before writing or launching an apply request", async () => {
    const fixture = await createFixture();
    const helperPath = path.join(fixture.root, "native", "source-update-helper.exe");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "changed helper", "utf8");
    const launchHelper = vi.fn(async () => undefined);
    const supervisor = new ProductSourceApplySupervisor({
      rootDir: fixture.root,
      sourceOwner: fixture.sourceOwner,
      helperPath,
      helperSha256: "b".repeat(64),
      restart: {
        executable: path.join(fixture.root, "node.exe"),
        args: ["gateway.js"],
        workingDirectory: fixture.sourceRoot,
        healthUrl: "http://127.0.0.1:8787/health",
      },
      platform: "win32",
      launchHelper,
    });
    await expect(
      supervisor.launchApply({ plan: fixture.plan, manifest: fixture.manifest, approvalIds: ["approval-1"] }),
    ).resolves.toEqual({ status: "failed", failureCode: "native_helper_binding_conflict" });
    expect(launchHelper).not.toHaveBeenCalled();
  });

  it("relaunches an exact stale request for crash recovery and eventually fails closed without a result", async () => {
    const fixture = await createFixture();
    const helperPath = path.join(fixture.root, "native", "source-update-helper.exe");
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    await fs.writeFile(helperPath, "verified helper bytes", "utf8");
    let now = Date.parse("2026-08-13T12:00:00.000Z");
    const launchHelper = vi.fn(async () => undefined);
    const supervisor = new ProductSourceApplySupervisor({
      rootDir: fixture.root,
      sourceOwner: fixture.sourceOwner,
      helperPath,
      helperSha256: sha256("verified helper bytes"),
      restart: {
        executable: path.join(fixture.root, "node.exe"),
        args: ["gateway.js"],
        workingDirectory: fixture.sourceRoot,
        healthUrl: "http://127.0.0.1:8787/health",
      },
      platform: "win32",
      parentPid: 1234,
      parentStartedAtUnixMs: 1_765_000_000_000,
      now: () => now,
      pendingRelaunchAfterMs: 1_000,
      pendingFailAfterMs: 60_000,
      launchHelper,
    });
    await expect(
      supervisor.launchApply({
        plan: fixture.plan,
        manifest: fixture.manifest,
        approvalIds: ["approval-1"],
      }),
    ).resolves.toMatchObject({ status: "running" });
    expect(launchHelper).toHaveBeenCalledTimes(1);

    now += 2_000;
    await expect(supervisor.inspect(fixture.manifest)).resolves.toMatchObject({ status: "running" });
    expect(launchHelper).toHaveBeenCalledTimes(2);
    expect(launchHelper.mock.calls[1]).toEqual(launchHelper.mock.calls[0]);

    now += 60_000;
    await expect(supervisor.inspect(fixture.manifest)).resolves.toMatchObject({
      status: "failed",
      failureCode: "native_helper_result_timeout",
    });
    expect(launchHelper).toHaveBeenCalledTimes(2);
  });
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-source-supervisor-"));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  await fs.mkdir(sourceRoot, { recursive: true });
  const artifactDirectory = path.join(root, "artifacts", "evolution", "source-updates", "plan-1");
  await fs.mkdir(artifactDirectory, { recursive: true });
  const patch = "diff --git a/example.ts b/example.ts\n";
  await fs.writeFile(path.join(artifactDirectory, "approved.patch"), patch, "utf8");
  await fs.writeFile(path.join(artifactDirectory, "rollback.patch"), patch, "utf8");
  const install: ManagedSourceInstallRecord = {
    installId: "install-1",
    label: "GoatCitadel",
    canonicalRoot: sourceRoot,
    repositoryIdentitySha256: "1".repeat(64),
    baselineSha: "2".repeat(40),
    baselineTree: "3".repeat(40),
    platform: "win32",
    volumeId: "4".repeat(64),
    status: "active",
    revision: 2,
    registeredAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const manifest: ProductSourceUpdateManifestRecord = {
    manifestId: "manifest-1",
    planId: "plan-1",
    installId: install.installId,
    installRevision: install.revision,
    baseSha: install.baselineSha,
    baseTree: install.baselineTree,
    patchSha256: sha256(patch),
    patchArtifactRelPath: "artifacts/evolution/source-updates/plan-1/approved.patch",
    rollbackSha256: sha256(patch),
    rollbackArtifactRelPath: "artifacts/evolution/source-updates/plan-1/rollback.patch",
    changedFiles: [
      { path: "example.ts", changeKind: "modified", beforeSha256: "5".repeat(64), afterSha256: "6".repeat(64) },
    ],
    validations: [{ proofId: "typecheck", status: "passed" }],
    riskClass: "caution",
    protectedAreas: [],
    codeModeRunId: "code-run-1",
    manifestSha256: "7".repeat(64),
    createdAt: new Date().toISOString(),
  };
  const plan = {
    planId: "plan-1",
    approvalRefs: ["approval-1"],
  } as ChangePlanRecord;
  const sourceOwner = {
    inspectRegistered: vi.fn(async () => ({
      record: install,
      current: {
        canonicalRoot: sourceRoot,
        label: install.label,
        repositoryIdentitySha256: install.repositoryIdentitySha256,
        baselineSha: install.baselineSha,
        baselineTree: install.baselineTree,
        platform: install.platform,
        volumeId: install.volumeId,
      },
      matchesBaseline: true,
    })),
  };
  return { root, sourceRoot, manifest, plan, sourceOwner };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
