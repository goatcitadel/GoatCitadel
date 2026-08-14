import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeModeRunRecord, CodeModeVerificationEvidenceRecord } from "@goatcitadel/contracts";
import { createDatabase, ProductSourceUpdateRepository, type ManagedSourceInstallRecord } from "@goatcitadel/storage";
import { ProductSourceUpdateService, classifyProtectedAreas } from "./product-source-update-service.js";

const roots: string[] = [];
const databases: Array<ReturnType<typeof createDatabase>> = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("ProductSourceUpdateService", () => {
  it("stages only a verified Code Mode worktree and leaves the registered root untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-product-source-"));
    roots.push(root);
    const sourceRoot = path.join(root, "source");
    const worktreePath = path.join(root, "worktree");
    await fs.mkdir(path.join(sourceRoot, "apps", "gateway", "src"), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "apps", "gateway", "src", "example.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "goatcitadel@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "GoatCitadel Test"]);
    git(sourceRoot, ["add", "."]);
    git(sourceRoot, ["commit", "-m", "baseline"]);
    const baseSha = git(sourceRoot, ["rev-parse", "HEAD"]);
    const baseTree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
    git(sourceRoot, ["worktree", "add", "--detach", worktreePath, baseSha]);
    await fs.writeFile(
      path.join(worktreePath, "apps", "gateway", "src", "example.ts"),
      "export const value = 2;\n",
      "utf8",
    );

    const install: ManagedSourceInstallRecord = {
      installId: "install-1",
      label: "GoatCitadel",
      canonicalRoot: sourceRoot,
      repositoryIdentitySha256: "a".repeat(64),
      baselineSha: baseSha,
      baselineTree: baseTree,
      platform: "win32",
      volumeId: "b".repeat(64),
      status: "active",
      revision: 2,
      registeredAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const evidence = verificationEvidence(baseSha);
    const codeModeRun = {
      runId: "code-run-1",
      status: "completed",
      sessionId: "session-1",
      workspaceId: "default",
      verification: {
        status: "verified",
        evidenceId: evidence.evidenceId,
        subjectHash: evidence.subject.subjectHash,
        updatedAt: new Date().toISOString(),
      },
    } as CodeModeRunRecord;
    const db = createDatabase({ dbPath: path.join(root, "storage.db") });
    databases.push(db);
    const repository = new ProductSourceUpdateRepository(db);
    const runWorkbenchCommand = vi.fn(async () => ({
      run: {
        commandRunId: `command-${runWorkbenchCommand.mock.calls.length}`,
        sessionId: "session-1",
        command: "git",
        args: ["diff", "--check"],
        status: "passed",
        exitCode: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        validationStatus: "passed",
      },
    }));
    const service = new ProductSourceUpdateService({
      rootDir: root,
      artifactRoot: path.join(root, "artifacts"),
      repository,
      sourceOwner: {
        inspectRegistered: vi.fn(async () => ({
          record: install,
          current: {
            canonicalRoot: sourceRoot,
            label: install.label,
            repositoryIdentitySha256: install.repositoryIdentitySha256,
            baselineSha: baseSha,
            baselineTree: baseTree,
            platform: "win32" as const,
            volumeId: install.volumeId,
          },
          matchesBaseline: true,
        })),
      },
      getCodeModeRun: vi.fn(async () => codeModeRun),
      getCodeModeVerificationEvidence: vi.fn(async () => [evidence]),
      getWorkbench: vi.fn(async () => ({
        sessionId: "session-1",
        projectId: "project-1",
        worktreePath,
        worktreeStatus: "ready" as const,
        baseRef: baseSha,
        validationStatus: "passed" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      runWorkbenchCommand,
    });

    const manifest = await service.stage({
      planId: "plan-source-1",
      workspaceId: "default",
      sourceInstallId: "install-1",
      codeModeRunId: "code-run-1",
      changeSummary: "Update the reviewed example value.",
    });

    expect(manifest.changedFiles).toEqual([
      expect.objectContaining({ path: "apps/gateway/src/example.ts", changeKind: "modified" }),
    ]);
    expect(manifest.validations.map((item) => [item.proofId, item.status])).toEqual([
      ["code_mode_verified", "passed"],
      ["git_diff_check", "passed"],
      ["workspace_typecheck", "passed"],
    ]);
    expect(service.project(manifest)).toMatchObject({ applyEligible: true, blockers: [] });
    expect(await fs.readFile(path.join(sourceRoot, "apps", "gateway", "src", "example.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    await expect(service.verifyManifest(manifest.manifestId)).resolves.toMatchObject({
      manifestId: manifest.manifestId,
    });
  }, 20_000);

  it("classifies protected control-plane, trust, dependency, and migration paths", () => {
    expect(
      classifyProtectedAreas([
        "apps/gateway/src/services/evolution-control-plane-service.ts",
        "packages/policy-engine/src/tool-executor.ts",
        "scripts/packaging/build-windows-native-installer.mjs",
        "pnpm-lock.yaml",
        "packages/storage/src/sqlite.ts",
      ]),
    ).toEqual(
      expect.arrayContaining([
        "evolution_control_plane",
        "auth_policy_approvals_secrets",
        "installer_signing_trust",
        "dependency_manifest",
        "migration",
      ]),
    );
  });
});

function verificationEvidence(baseSha: string): CodeModeVerificationEvidenceRecord {
  const now = new Date().toISOString();
  return {
    evidenceId: "proof-1",
    runId: "code-run-1",
    status: "verified",
    workspaceId: "default",
    sessionId: "session-1",
    commandName: "typecheck",
    commandLabel: "pnpm typecheck",
    command: "pnpm",
    args: ["typecheck"],
    scope: "full",
    commandStatus: "passed",
    exitCode: 0,
    startedAt: now,
    finishedAt: now,
    stdoutTruncated: false,
    stderrTruncated: false,
    outputArtifactRefs: [],
    subject: {
      subjectHash: "c".repeat(64),
      codeModeInputHash: "d".repeat(64),
      codeHash: "e".repeat(64),
      wrapperManifestHash: "f".repeat(64),
      policySnapshotHash: "1".repeat(64),
      worktreeIdentityHash: "2".repeat(64),
      worktreeStateHash: "3".repeat(64),
      worktreeHeadHash: baseSha,
      changedFiles: ["apps/gateway/src/example.ts"],
      changedFilesTruncated: false,
      artifacts: [],
    },
    createdAt: now,
  };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
