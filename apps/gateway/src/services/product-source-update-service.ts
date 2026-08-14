import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  ConflictError,
  SemanticValidationError,
  canonicalJsonString,
  type AgenticCommandRunRecord,
  type ChatSessionWorkbenchRecord,
  type CodeModeRunRecord,
  type CodeModeVerificationEvidenceRecord,
} from "@goatcitadel/contracts";
import type {
  ManagedSourceInstallRecord,
  ProductSourceChangedFileRecord,
  ProductSourceUpdateEventRecord,
  ProductSourceUpdateManifestRecord,
  ProductSourceUpdateManifestCreateInput,
  ProductSourceUpdateRepository,
  ProductSourceValidationRecord,
} from "@goatcitadel/storage";
import type { ManagedSourceInstallService, ManagedSourceInspection } from "./managed-source-install-service.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 32 * 1_024 * 1_024;
const MAX_GIT_OUTPUT_BYTES = 40 * 1_024 * 1_024;
const MAX_CHANGED_FILES = 2_000;

type SourceOwner = Pick<ManagedSourceInstallService, "inspectRegistered">;
interface SourceUpdateRepository {
  appendEvent(
    manifestId: string,
    input: Parameters<ProductSourceUpdateRepository["appendEvent"]>[1],
  ): ProductSourceUpdateEventRecord | Promise<ProductSourceUpdateEventRecord>;
  createManifest(
    input: ProductSourceUpdateManifestCreateInput,
  ): ProductSourceUpdateManifestRecord | Promise<ProductSourceUpdateManifestRecord>;
  findByPlan(
    planId: string,
  ): ProductSourceUpdateManifestRecord | undefined | Promise<ProductSourceUpdateManifestRecord | undefined>;
  getManifest(manifestId: string): ProductSourceUpdateManifestRecord | Promise<ProductSourceUpdateManifestRecord>;
  listEvents(manifestId: string): ProductSourceUpdateEventRecord[] | Promise<ProductSourceUpdateEventRecord[]>;
}

export interface ProductSourceUpdateServiceDependencies {
  readonly rootDir: string;
  readonly sourceOwner: SourceOwner;
  readonly repository: SourceUpdateRepository;
  readonly getCodeModeRun: (runId: string) => Promise<CodeModeRunRecord>;
  readonly getCodeModeVerificationEvidence: (runId: string) => Promise<readonly CodeModeVerificationEvidenceRecord[]>;
  readonly getWorkbench: (sessionId: string) => Promise<ChatSessionWorkbenchRecord>;
  readonly runWorkbenchCommand: (
    sessionId: string,
    input: { command: string; args: string[]; timeoutMs?: number },
  ) => Promise<{ run: AgenticCommandRunRecord }>;
  readonly artifactRoot?: string;
}

export interface ProductSourceUpdateStageInput {
  readonly planId: string;
  readonly workspaceId: string;
  readonly sourceInstallId: string;
  readonly codeModeRunId: string;
  readonly changeSummary: string;
}

export interface ProductSourceUpdatePublicManifest {
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly baseSha: string;
  readonly baseTree: string;
  readonly patchSha256: string;
  readonly rollbackSha256: string;
  readonly changedFiles: readonly ProductSourceChangedFileRecord[];
  readonly validations: readonly ProductSourceValidationRecord[];
  readonly riskClass: ProductSourceUpdateManifestRecord["riskClass"];
  readonly protectedAreas: readonly string[];
  readonly codeModeRunId: string;
  readonly createdAt: string;
  readonly applyEligible: boolean;
  readonly blockers: readonly string[];
}

/**
 * Private staging owner for product-source evolution. It consumes only a
 * completed and freshly verified Code Mode worktree. No operation in this
 * class writes the registered live source root.
 */
export class ProductSourceUpdateService {
  private readonly artifactRoot: string;

  public constructor(private readonly deps: ProductSourceUpdateServiceDependencies) {
    this.artifactRoot = path.resolve(
      deps.artifactRoot ?? path.join(deps.rootDir, "artifacts", "evolution", "source-updates"),
    );
    assertWithin(path.resolve(deps.rootDir), this.artifactRoot, "Product source update artifact root");
  }

  public async inspectInstall(sourceInstallId: string): Promise<{
    record: ManagedSourceInstallRecord;
    current: ManagedSourceInspection;
  }> {
    const inspection = await this.deps.sourceOwner.inspectRegistered(sourceInstallId);
    if (inspection.record.status !== "active") {
      throw new SemanticValidationError("Product source updates require an active managed source registration.");
    }
    if (!inspection.matchesBaseline) {
      throw new ConflictError({
        message: "The managed source install changed after registration. Register a fresh clean baseline.",
      });
    }
    return inspection;
  }

  public async stage(input: ProductSourceUpdateStageInput): Promise<ProductSourceUpdateManifestRecord> {
    const replay = await this.deps.repository.findByPlan(input.planId);
    if (replay) return replay;
    const source = await this.inspectInstall(input.sourceInstallId);
    const run = await this.deps.getCodeModeRun(input.codeModeRunId);
    assertCodeModeRun(run, input);
    const evidence = await requireFreshCodeModeEvidence(run, this.deps.getCodeModeVerificationEvidence);
    const workbench = await this.deps.getWorkbench(run.sessionId!);
    const worktreePath = await inspectBoundWorktree(workbench, source.record, evidence);
    const capture = await captureWorktreeCandidate(worktreePath);
    assertSameChangedFiles(
      capture.changedFiles.map((entry) => entry.path),
      evidence.subject.changedFiles,
    );

    const validations = await this.runSelectedValidation(run.sessionId!, capture.changedFiles, evidence);
    const protectedAreas = classifyProtectedAreas(capture.changedFiles.map((entry) => entry.path));
    const riskClass = protectedAreas.length > 0 ? ("protected_core" as const) : ("caution" as const);
    const artifactDirectory = path.join(this.artifactRoot, safeSegment(input.planId));
    await fs.mkdir(artifactDirectory, { recursive: true });
    const patchArtifact = await writeImmutableArtifact(artifactDirectory, "approved.patch", capture.patch);
    const rollbackArtifact = await writeImmutableArtifact(artifactDirectory, "rollback.patch", capture.rollbackPatch);
    const patchArtifactRelPath = toRootRelativePath(this.deps.rootDir, patchArtifact.path);
    const rollbackArtifactRelPath = toRootRelativePath(this.deps.rootDir, rollbackArtifact.path);
    const material = {
      schemaVersion: 1,
      planId: input.planId,
      installId: source.record.installId,
      installRevision: source.record.revision,
      baseSha: source.record.baselineSha,
      baseTree: source.record.baselineTree,
      patchSha256: patchArtifact.sha256,
      patchArtifactRelPath,
      rollbackSha256: rollbackArtifact.sha256,
      rollbackArtifactRelPath,
      changedFiles: capture.changedFiles,
      validations,
      riskClass,
      protectedAreas,
      codeModeRunId: run.runId,
      changeSummaryHash: sha256(input.changeSummary.trim()),
    };
    const manifestSha256 = sha256(canonicalJsonString(material));
    await writeImmutableArtifact(
      artifactDirectory,
      "manifest.json",
      `${canonicalJsonString({ ...material, manifestSha256 })}\n`,
    );
    const create: ProductSourceUpdateManifestCreateInput = {
      ...material,
      manifestSha256,
    };
    return await this.deps.repository.createManifest(create);
  }

  public async getManifestForPlan(planId: string): Promise<ProductSourceUpdateManifestRecord> {
    const manifest = await this.deps.repository.findByPlan(planId);
    if (!manifest) throw new SemanticValidationError("This Change Plan has no staged product source manifest.");
    return manifest;
  }

  public async verifyManifest(manifestId: string): Promise<ProductSourceUpdateManifestRecord> {
    const manifest = await this.deps.repository.getManifest(manifestId);
    const source = await this.inspectInstall(manifest.installId);
    if (
      source.record.revision !== manifest.installRevision ||
      source.record.baselineSha !== manifest.baseSha ||
      source.record.baselineTree !== manifest.baseTree
    ) {
      throw new ConflictError({ message: "Managed source registration or baseline changed after staging." });
    }
    await verifyPrivateArtifact(this.deps.rootDir, manifest.patchArtifactRelPath, manifest.patchSha256);
    await verifyPrivateArtifact(this.deps.rootDir, manifest.rollbackArtifactRelPath, manifest.rollbackSha256);
    return manifest;
  }

  public project(manifest: ProductSourceUpdateManifestRecord): ProductSourceUpdatePublicManifest {
    const blockers = applyBlockers(manifest);
    return {
      manifestId: manifest.manifestId,
      manifestSha256: manifest.manifestSha256,
      baseSha: manifest.baseSha,
      baseTree: manifest.baseTree,
      patchSha256: manifest.patchSha256,
      rollbackSha256: manifest.rollbackSha256,
      changedFiles: manifest.changedFiles,
      validations: manifest.validations,
      riskClass: manifest.riskClass,
      protectedAreas: manifest.protectedAreas,
      codeModeRunId: manifest.codeModeRunId,
      createdAt: manifest.createdAt,
      applyEligible: blockers.length === 0,
      blockers,
    };
  }

  public async appendEvent(
    manifestId: string,
    event: Parameters<SourceUpdateRepository["appendEvent"]>[1],
  ): Promise<ProductSourceUpdateEventRecord> {
    return await this.deps.repository.appendEvent(manifestId, event);
  }

  public async listEvents(manifestId: string): Promise<ProductSourceUpdateEventRecord[]> {
    return await this.deps.repository.listEvents(manifestId);
  }

  private async runSelectedValidation(
    sessionId: string,
    changedFiles: readonly ProductSourceChangedFileRecord[],
    evidence: CodeModeVerificationEvidenceRecord,
  ): Promise<ProductSourceValidationRecord[]> {
    const validations: ProductSourceValidationRecord[] = [
      {
        proofId: "code_mode_verified",
        status: "passed",
        evidenceRef: `code-mode-proof:${evidence.evidenceId}:sha256:${evidence.subject.subjectHash}`,
      },
    ];
    const paths = changedFiles.map((entry) => entry.path);
    const specs = selectProofs(paths);
    for (const spec of specs) {
      const startedAt = Date.now();
      try {
        const response = await this.deps.runWorkbenchCommand(sessionId, spec.command);
        validations.push({
          proofId: spec.proofId,
          status:
            response.run.status === "passed" && response.run.exitCode === 0
              ? "passed"
              : response.run.status === "timed_out"
                ? "timed_out"
                : "failed",
          ...(response.run.exitCode !== undefined ? { exitCode: response.run.exitCode } : {}),
          durationMs: Math.max(0, Date.now() - startedAt),
          evidenceRef: `workbench-command:${response.run.commandRunId}`,
        });
      } catch {
        validations.push({ proofId: spec.proofId, status: "failed", durationMs: Math.max(0, Date.now() - startedAt) });
      }
    }
    return validations;
  }
}

function assertCodeModeRun(run: CodeModeRunRecord, input: ProductSourceUpdateStageInput): void {
  if (run.status !== "completed" || !run.sessionId) {
    throw new SemanticValidationError(
      "Product source staging requires a completed Code Mode run linked to a Chat workbench.",
    );
  }
  if (run.workspaceId && run.workspaceId !== input.workspaceId) {
    throw new SemanticValidationError("The Code Mode run belongs to a different workspace.");
  }
  if (run.verification?.status !== "verified" || !run.verification.evidenceId || !run.verification.subjectHash) {
    throw new SemanticValidationError("The Code Mode run needs fresh named verification before source staging.");
  }
}

async function requireFreshCodeModeEvidence(
  run: CodeModeRunRecord,
  listEvidence: ProductSourceUpdateServiceDependencies["getCodeModeVerificationEvidence"],
): Promise<CodeModeVerificationEvidenceRecord> {
  const evidence = (await listEvidence(run.runId)).find(
    (candidate) => candidate.evidenceId === run.verification?.evidenceId,
  );
  if (
    !evidence ||
    evidence.status !== "verified" ||
    evidence.subject.subjectHash !== run.verification?.subjectHash ||
    evidence.subject.changedFilesTruncated
  ) {
    throw new ConflictError({ message: "Code Mode verification evidence is missing, stale, or truncated." });
  }
  return evidence;
}

async function inspectBoundWorktree(
  workbench: ChatSessionWorkbenchRecord,
  install: ManagedSourceInstallRecord,
  evidence: CodeModeVerificationEvidenceRecord,
): Promise<string> {
  if (workbench.worktreeStatus !== "ready" || !workbench.worktreePath) {
    throw new SemanticValidationError("The Code Mode worktree is not ready for source staging.");
  }
  const worktreePath = path.resolve(workbench.worktreePath);
  const realWorktree = await fs.realpath(worktreePath);
  if (path.normalize(realWorktree) !== path.normalize(worktreePath)) {
    throw new SemanticValidationError("The Code Mode worktree uses an unsafe path alias or reparse redirect.");
  }
  const head = requireGitObject(await git(worktreePath, ["rev-parse", "HEAD"]));
  if (head !== install.baselineSha || evidence.subject.worktreeHeadHash !== head) {
    throw new ConflictError({
      message: "The Code Mode worktree is not based on the registered exact source baseline.",
    });
  }
  const commonDirRaw = (await git(worktreePath, ["rev-parse", "--git-common-dir"])).trim();
  const commonDir = await fs.realpath(path.resolve(worktreePath, commonDirRaw));
  const registeredGitDir = await fs.realpath(path.join(install.canonicalRoot, ".git"));
  if (path.normalize(commonDir) !== path.normalize(registeredGitDir)) {
    throw new SemanticValidationError("The Code Mode worktree belongs to a foreign repository.");
  }
  const staged = await git(worktreePath, ["diff", "--cached", "--name-only", "--"]);
  if (staged.trim()) {
    throw new SemanticValidationError(
      "Source staging requires an unstaged Code Mode worktree so its index can be captured without ambiguity.",
    );
  }
  return worktreePath;
}

async function captureWorktreeCandidate(worktreePath: string): Promise<{
  patch: string;
  rollbackPatch: string;
  changedFiles: ProductSourceChangedFileRecord[];
}> {
  const statusBefore = await git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!statusBefore) throw new SemanticValidationError("The Code Mode worktree has no source changes to stage.");
  await git(worktreePath, ["add", "--intent-to-add", "--", "."]);
  try {
    const paths = parseNameStatus(await git(worktreePath, ["diff", "--name-status", "-z", "HEAD", "--", "."]));
    if (paths.length < 1 || paths.length > MAX_CHANGED_FILES) {
      throw new SemanticValidationError("The staged source update has an invalid changed-file count.");
    }
    if (paths.some((entry) => entry.changeKind === "renamed")) {
      throw new SemanticValidationError(
        "Live source apply v1 requires renames to be represented as an explicit delete and add.",
      );
    }
    for (const entry of paths) await assertSafeChangedPath(worktreePath, entry.path, entry.changeKind === "deleted");
    const patch = await git(
      worktreePath,
      ["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--", "."],
      MAX_PATCH_BYTES,
    );
    const rollbackPatch = await git(
      worktreePath,
      ["diff", "-R", "--binary", "--full-index", "--no-ext-diff", "HEAD", "--", "."],
      MAX_PATCH_BYTES,
    );
    if (!patch.trim() || !rollbackPatch.trim())
      throw new SemanticValidationError("Code Mode did not produce a complete reversible patch.");
    const changedFiles: ProductSourceChangedFileRecord[] = [];
    for (const entry of paths) {
      const before =
        entry.changeKind === "added" ? undefined : gitFileAtHead(worktreePath, entry.beforePath ?? entry.path);
      const after =
        entry.changeKind === "deleted"
          ? undefined
          : await fs.readFile(path.join(worktreePath, ...entry.path.split("/")));
      changedFiles.push({
        path: entry.path,
        changeKind: entry.changeKind,
        ...(before ? { beforeSha256: sha256(before) } : {}),
        ...(after ? { afterSha256: sha256(after) } : {}),
      });
    }
    return { patch, rollbackPatch, changedFiles };
  } finally {
    await git(worktreePath, ["reset", "--mixed", "HEAD", "--", "."]).catch(() => undefined);
  }
}

function parseNameStatus(raw: string): Array<{
  path: string;
  beforePath?: string;
  changeKind: ProductSourceChangedFileRecord["changeKind"];
}> {
  const fields = raw.split("\0").filter(Boolean);
  const out: Array<{ path: string; beforePath?: string; changeKind: ProductSourceChangedFileRecord["changeKind"] }> =
    [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]!;
    const code = status[0];
    if (code === "R" || code === "C") {
      const beforePath = normalizeRelativeGitPath(fields[index++] ?? "");
      const nextPath = normalizeRelativeGitPath(fields[index++] ?? "");
      out.push({ path: nextPath, beforePath, changeKind: "renamed" });
      continue;
    }
    const nextPath = normalizeRelativeGitPath(fields[index++] ?? "");
    out.push({
      path: nextPath,
      changeKind: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
    });
  }
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertSafeChangedPath(worktreePath: string, relPath: string, deleted: boolean): Promise<void> {
  const root = path.resolve(worktreePath);
  let cursor = root;
  const parts = relPath.split("/");
  for (let index = 0; index < parts.length - (deleted ? 1 : 0); index += 1) {
    cursor = path.join(cursor, parts[index]!);
    assertWithin(root, cursor, "Changed source path");
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink())
      throw new SemanticValidationError(`Changed source path ${relPath} crosses a symlink or reparse redirect.`);
  }
  if (!deleted) {
    const stat = await fs.lstat(path.join(root, ...parts));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SemanticValidationError(`Changed source path ${relPath} is not a regular file.`);
    }
  }
}

function gitFileAtHead(worktreePath: string, relPath: string): Buffer | undefined {
  try {
    return execFileSync("git", ["-C", worktreePath, "show", `HEAD:${relPath}`], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnv(),
    });
  } catch {
    return undefined;
  }
}

async function writeImmutableArtifact(
  directory: string,
  filename: string,
  content: string,
): Promise<{ path: string; sha256: string }> {
  const target = path.join(directory, filename);
  const digest = sha256(content);
  try {
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(target);
    if (sha256(existing) !== digest)
      throw new ConflictError({
        message: "A product source artifact path already contains different immutable bytes.",
      });
  }
  return { path: target, sha256: digest };
}

async function verifyPrivateArtifact(rootDir: string, relPath: string, expectedSha256: string): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...relPath.split("/"));
  assertWithin(root, target, "Product source update artifact");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConflictError({ message: "Product source update artifact is missing or unsafe." });
  const actual = sha256(await fs.readFile(target));
  if (actual !== expectedSha256)
    throw new ConflictError({ message: "Product source update artifact hash changed after staging." });
}

function selectProofs(
  paths: readonly string[],
): Array<{ proofId: string; command: { command: string; args: string[]; timeoutMs: number } }> {
  const proofs = [
    {
      proofId: "git_diff_check",
      command: { command: "git", args: ["diff", "--check"], timeoutMs: 120_000 },
    },
  ];
  const onlyDocs = paths.every((item) => item.startsWith("docs/") || /(?:^|\/)README(?:\.[^/]*)?$/iu.test(item));
  proofs.push(
    onlyDocs
      ? { proofId: "docs_check", command: { command: "pnpm", args: ["docs:check"], timeoutMs: 10 * 60_000 } }
      : { proofId: "workspace_typecheck", command: { command: "pnpm", args: ["typecheck"], timeoutMs: 10 * 60_000 } },
  );
  if (paths.some(isDependencyPath)) {
    proofs.push(
      {
        proofId: "dependency_verified_prefetch",
        command: { command: "pnpm", args: ["fetch", "--frozen-lockfile"], timeoutMs: 20 * 60_000 },
      },
      {
        proofId: "dependency_frozen_offline_install",
        command: { command: "pnpm", args: ["install", "--offline", "--frozen-lockfile"], timeoutMs: 20 * 60_000 },
      },
      { proofId: "dependency_risk", command: { command: "pnpm", args: ["dependency:risk"], timeoutMs: 10 * 60_000 } },
    );
  }
  if (paths.some(isMigrationPath)) {
    proofs.push(
      {
        proofId: "storage_migration_parity",
        command: { command: "pnpm", args: ["verify:storage:migration-parity"], timeoutMs: 20 * 60_000 },
      },
      {
        proofId: "sqlite_backup_clone_migration",
        command: { command: "pnpm", args: ["verify:backup:roundtrip"], timeoutMs: 20 * 60_000 },
      },
    );
  }
  return proofs;
}

export function classifyProtectedAreas(paths: readonly string[]): string[] {
  const categories = new Set<string>();
  for (const file of paths) {
    const normalized = file.toLowerCase();
    if (/change-plan|evolution-control-plane|managed-source|product-source-update/u.test(normalized))
      categories.add("evolution_control_plane");
    if (/supervisor|updater|update-helper|mission-control-windows/u.test(normalized))
      categories.add("updater_helper_supervisor");
    if (/(?:^|\/)(auth|policy|approvals?|secrets?)(?:\/|[-_.])/u.test(normalized))
      categories.add("auth_policy_approvals_secrets");
    if (/installer|signing|trust-root|release-trust/u.test(normalized)) categories.add("installer_signing_trust");
    if (isDependencyPath(normalized)) categories.add("dependency_manifest");
    if (/\.(?:dll|exe|node|so|dylib)$/u.test(normalized)) categories.add("native_binary");
    if (isMigrationPath(normalized)) categories.add("migration");
  }
  return [...categories].sort();
}

function applyBlockers(manifest: ProductSourceUpdateManifestRecord): string[] {
  const blockers = manifest.validations
    .filter((validation) => validation.status !== "passed")
    .map((validation) => `proof:${validation.proofId}:${validation.status}`);
  if (manifest.changedFiles.some((entry) => isPostgresMigrationPath(entry.path))) {
    blockers.push("postgres_restore_owner_required");
  }
  if (manifest.protectedAreas.includes("native_binary")) blockers.push("native_binary_live_apply_not_supported");
  return [...new Set(blockers)].sort();
}

function assertSameChangedFiles(actual: readonly string[], verified: readonly string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(verified.map(normalizeRelativeGitPath))].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new ConflictError({
      message: "The Code Mode worktree changed after its verification evidence was recorded.",
    });
  }
}

function isDependencyPath(file: string): boolean {
  return /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|Cargo\.lock|requirements[^/]*\.txt)$/iu.test(
    file,
  );
}

function isMigrationPath(file: string): boolean {
  return /(?:^|\/)(?:migrations?|schema)(?:\/|[-_.])/iu.test(file) || /\/sqlite\.ts$/iu.test(file);
}

function isPostgresMigrationPath(file: string): boolean {
  const normalized = file.toLowerCase().replaceAll("\\", "/");
  return normalized.includes("/postgres/") || /(?:^|\/)postgres[^/]*(?:migration|schema)/u.test(normalized);
}

function normalizeRelativeGitPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new SemanticValidationError("Code Mode reported an unsafe changed-file path.");
  }
  return normalized;
}

function toRootRelativePath(rootDir: string, target: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(target);
  assertWithin(root, resolved, "Product source artifact");
  return path.relative(root, resolved).replaceAll("\\", "/");
}

function safeSegment(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(normalized))
    throw new SemanticValidationError("Product source Change Plan ID is invalid.");
  return normalized;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (path.resolve(root) === path.resolve(candidate) && label.endsWith("root")) return;
    throw new SemanticValidationError(`${label} escapes its Gateway-owned path jail.`);
  }
}

async function git(root: string, args: readonly string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 10 * 60_000,
      windowsHide: true,
      maxBuffer,
      env: gitEnv(),
    });
    return stdout;
  } catch (error) {
    throw new SemanticValidationError(
      `Product source Git inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
}

function requireGitObject(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized))
    throw new SemanticValidationError("Git returned an invalid source object ID.");
  return normalized;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
