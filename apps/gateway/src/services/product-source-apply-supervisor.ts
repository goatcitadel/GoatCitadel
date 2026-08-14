import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ConflictError,
  SemanticValidationError,
  canonicalJsonString,
  type ChangePlanRecord,
} from "@goatcitadel/contracts";
import type { ProductSourceChangedFileRecord, ProductSourceUpdateManifestRecord } from "@goatcitadel/storage";
import type { ManagedSourceInstallService } from "./managed-source-install-service.js";
import type {
  ProductSourceApplyObservation,
  ProductSourceApplySupervisorPort,
} from "./product-source-update-change-plan-adapter.js";

type SourceOwner = Pick<ManagedSourceInstallService, "inspectRegistered">;

export interface ProductSourceRestartDescriptor {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly healthUrl: string;
  readonly healthTimeoutMs?: number;
}

export interface ProductSourceApplySupervisorDependencies {
  /** Gateway private runtime/data root containing the immutable artifacts. */
  readonly rootDir: string;
  readonly sourceOwner: SourceOwner;
  readonly helperPath?: string;
  readonly helperSha256?: string;
  readonly restart?: ProductSourceRestartDescriptor;
  readonly platform?: NodeJS.Platform;
  readonly parentPid?: number;
  /** Process-birth witness prevents a stale request from killing a reused PID during recovery. */
  readonly parentStartedAtUnixMs?: number;
  readonly launchHelper?: (helperPath: string, args: readonly string[]) => Promise<void>;
  readonly now?: () => number;
  readonly pendingRelaunchAfterMs?: number;
  readonly pendingFailAfterMs?: number;
}

export function readProductSourceApplySupervisorConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ProductSourceApplySupervisorDependencies, "helperPath" | "helperSha256" | "restart"> {
  const helperPath = env.GOATCITADEL_SOURCE_UPDATE_HELPER_PATH?.trim();
  const helperSha256 = env.GOATCITADEL_SOURCE_UPDATE_HELPER_SHA256?.trim();
  const executable = env.GOATCITADEL_SOURCE_UPDATE_RESTART_EXECUTABLE?.trim();
  const workingDirectory = env.GOATCITADEL_SOURCE_UPDATE_RESTART_WORKING_DIRECTORY?.trim();
  const healthUrl = env.GOATCITADEL_SOURCE_UPDATE_HEALTH_URL?.trim();
  let args: string[] | undefined;
  const rawArgs = env.GOATCITADEL_SOURCE_UPDATE_RESTART_ARGS_JSON?.trim();
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) args = parsed;
    } catch {
      // An invalid installation-owned descriptor is treated as unavailable.
    }
  }
  const timeoutRaw = env.GOATCITADEL_SOURCE_UPDATE_HEALTH_TIMEOUT_MS?.trim();
  const timeout = timeoutRaw ? Number(timeoutRaw) : undefined;
  const restart =
    executable && workingDirectory && healthUrl && args
      ? {
          executable,
          args,
          workingDirectory,
          healthUrl,
          ...(Number.isSafeInteger(timeout) ? { healthTimeoutMs: timeout } : {}),
        }
      : undefined;
  return {
    ...(helperPath ? { helperPath } : {}),
    ...(helperSha256 ? { helperSha256 } : {}),
    ...(restart ? { restart } : {}),
  };
}

interface HelperRequest {
  readonly schemaVersion: 1;
  readonly operation: "apply" | "rollback";
  readonly planId: string;
  readonly manifestId: string;
  readonly manifestSha256: string;
  readonly installId: string;
  readonly installRevision: number;
  readonly sourceRoot: string;
  readonly expectedHead: string;
  readonly expectedTree: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly compensationPath: string;
  readonly compensationSha256: string;
  readonly changedFiles: readonly ProductSourceChangedFileRecord[];
  readonly approvalIds: readonly string[];
  readonly parentPid: number;
  readonly parentStartedAtUnixMs: number;
  readonly restart: ProductSourceRestartDescriptor;
  readonly resultPath: string;
  readonly journalPath: string;
  readonly createdAt: string;
}

interface HelperResult {
  readonly schemaVersion: 1;
  readonly operation: "apply" | "rollback";
  readonly manifestId: string;
  readonly requestSha256: string;
  readonly status: "succeeded" | "rolled_back" | "failed" | "rollback_failed";
  readonly baselineSha?: string;
  readonly baselineTree?: string;
  readonly failureCode?: string;
  readonly evidenceSha256: string;
  readonly finishedAt: string;
}

/**
 * Gateway-side launcher for the Windows native promotion helper. The helper
 * executable and restart descriptor are installation-owned configuration;
 * neither can be supplied by a model or Change Plan request.
 */
export class ProductSourceApplySupervisor implements ProductSourceApplySupervisorPort {
  private readonly rootDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly parentPid: number;
  private readonly parentStartedAtUnixMs: number;
  private readonly now: () => number;
  private readonly pendingRelaunchAfterMs: number;
  private readonly pendingFailAfterMs: number;

  public constructor(private readonly deps: ProductSourceApplySupervisorDependencies) {
    this.rootDir = path.resolve(deps.rootDir);
    this.platform = deps.platform ?? process.platform;
    this.parentPid = deps.parentPid ?? process.pid;
    this.parentStartedAtUnixMs =
      deps.parentStartedAtUnixMs ?? Math.max(1, Math.round(Date.now() - process.uptime() * 1_000));
    this.now = deps.now ?? Date.now;
    this.pendingRelaunchAfterMs = boundedDuration(deps.pendingRelaunchAfterMs ?? 30_000, 1_000, 5 * 60_000);
    this.pendingFailAfterMs = boundedDuration(deps.pendingFailAfterMs ?? 30 * 60_000, 60_000, 24 * 60 * 60_000);
    if (this.pendingFailAfterMs <= this.pendingRelaunchAfterMs) {
      throw new TypeError("Native helper failure timeout must exceed its recovery relaunch delay.");
    }
  }

  public async launchApply(input: {
    plan: ChangePlanRecord;
    manifest: ProductSourceUpdateManifestRecord;
    approvalIds: readonly string[];
  }): Promise<ProductSourceApplyObservation> {
    return await this.launch("apply", input.plan, input.manifest, input.approvalIds);
  }

  public async launchRollback(input: {
    plan: ChangePlanRecord;
    manifest: ProductSourceUpdateManifestRecord;
  }): Promise<ProductSourceApplyObservation> {
    return await this.launch("rollback", input.plan, input.manifest, input.plan.approvalRefs);
  }

  public async inspect(manifest: ProductSourceUpdateManifestRecord): Promise<ProductSourceApplyObservation> {
    const apply = await this.readResult(manifest, "apply");
    const rollback = await this.readResult(manifest, "rollback");
    if (rollback) return rollback;
    if (apply) return apply;
    const pendingOperation = (await this.hasRequest(manifest, "rollback"))
      ? "rollback"
      : (await this.hasRequest(manifest, "apply"))
        ? "apply"
        : undefined;
    if (pendingOperation) return await this.resumePendingRequest(manifest, pendingOperation);
    return { status: "not_started" };
  }

  private async launch(
    operation: "apply" | "rollback",
    plan: ChangePlanRecord,
    manifest: ProductSourceUpdateManifestRecord,
    approvalIds: readonly string[],
  ): Promise<ProductSourceApplyObservation> {
    const existing = await this.readResult(manifest, operation);
    if (existing) return existing;
    try {
      if (await this.hasRequest(manifest, operation)) return await this.resumePendingRequest(manifest, operation);
      const configuration = await this.requireConfiguration();
      const source = await this.deps.sourceOwner.inspectRegistered(manifest.installId);
      const expected =
        operation === "apply"
          ? { head: manifest.baseSha, tree: manifest.baseTree }
          : await this.requireAppliedBaseline(manifest);
      if (
        source.record.status !== "active" ||
        (operation === "apply" && source.record.revision !== manifest.installRevision) ||
        source.current.baselineSha !== expected.head ||
        source.current.baselineTree !== expected.tree
      ) {
        throw new ConflictError({ message: "The registered source baseline changed before native helper launch." });
      }
      const paths = this.paths(manifest, operation);
      const patchRelPath = operation === "apply" ? manifest.patchArtifactRelPath : manifest.rollbackArtifactRelPath;
      const patchPath = resolvePrivatePath(this.rootDir, patchRelPath);
      const patchSha256 = operation === "apply" ? manifest.patchSha256 : manifest.rollbackSha256;
      const compensationRelPath =
        operation === "apply" ? manifest.rollbackArtifactRelPath : manifest.patchArtifactRelPath;
      const compensationPath = resolvePrivatePath(this.rootDir, compensationRelPath);
      const compensationSha256 = operation === "apply" ? manifest.rollbackSha256 : manifest.patchSha256;
      if ((await sha256File(patchPath)) !== patchSha256)
        throw new ConflictError({ message: "The approved helper patch hash changed before launch." });
      if ((await sha256File(compensationPath)) !== compensationSha256)
        throw new ConflictError({ message: "The approved helper compensation hash changed before launch." });
      const request: HelperRequest = {
        schemaVersion: 1,
        operation,
        planId: plan.planId,
        manifestId: manifest.manifestId,
        manifestSha256: manifest.manifestSha256,
        installId: manifest.installId,
        installRevision: source.record.revision,
        sourceRoot: source.record.canonicalRoot,
        expectedHead: expected.head,
        expectedTree: expected.tree,
        patchPath,
        patchSha256,
        compensationPath,
        compensationSha256,
        changedFiles: operation === "apply" ? manifest.changedFiles : reverseChangedFiles(manifest.changedFiles),
        approvalIds: [...new Set(approvalIds)].sort(),
        parentPid: this.parentPid,
        parentStartedAtUnixMs: this.parentStartedAtUnixMs,
        restart: configuration.restart,
        resultPath: paths.result,
        journalPath: paths.journal,
        createdAt: new Date(this.now()).toISOString(),
      };
      if (request.approvalIds.length < 1)
        throw new ConflictError({ message: "The native helper request has no canonical approval binding." });
      await fs.mkdir(path.dirname(paths.request), { recursive: true });
      const requestBytes = `${canonicalJsonString(request)}\n`;
      await writeImmutable(paths.request, requestBytes);
      const requestSha256 = sha256(requestBytes);
      await configuration.launch(configuration.helperPath, [
        "--request",
        paths.request,
        "--request-sha256",
        requestSha256,
      ]);
      return {
        status: "running",
        evidenceRefs: [`source-update-helper-request:${manifest.manifestId}:sha256:${requestSha256}`],
      };
    } catch (error) {
      return {
        status: operation === "rollback" ? "rollback_failed" : "failed",
        failureCode: helperFailureCode(error),
      };
    }
  }

  private async requireConfiguration(): Promise<{
    helperPath: string;
    restart: ProductSourceRestartDescriptor;
    launch: (helperPath: string, args: readonly string[]) => Promise<void>;
  }> {
    if (this.platform !== "win32")
      throw new SemanticValidationError("Live product source apply is supported only by the Windows native helper.");
    const helperPath = path.resolve(this.deps.helperPath?.trim() ?? "");
    const expectedHelperHash = normalizeSha256(this.deps.helperSha256 ?? "");
    if (!this.deps.helperPath || !this.deps.restart)
      throw new SemanticValidationError("The verified native source-update helper is not configured.");
    const stat = await fs.lstat(helperPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new SemanticValidationError("The configured native source-update helper is unsafe.");
    if ((await sha256File(helperPath)) !== expectedHelperHash)
      throw new ConflictError({ message: "The configured native source-update helper identity changed." });
    const restart = normalizeRestart(this.deps.restart);
    const launch = this.deps.launchHelper ?? launchDetached;
    return { helperPath, restart, launch };
  }

  private async requireAppliedBaseline(
    manifest: ProductSourceUpdateManifestRecord,
  ): Promise<{ head: string; tree: string }> {
    const applied = await this.readRawResult(manifest, "apply");
    if (applied?.status !== "succeeded" || !applied.baselineSha || !applied.baselineTree) {
      throw new ConflictError({ message: "Rollback requires a verified successful apply result." });
    }
    return { head: applied.baselineSha, tree: applied.baselineTree };
  }

  private async readResult(
    manifest: ProductSourceUpdateManifestRecord,
    operation: "apply" | "rollback",
  ): Promise<ProductSourceApplyObservation | undefined> {
    const result = await this.readRawResult(manifest, operation);
    if (!result) return undefined;
    const requestPath = this.paths(manifest, operation).request;
    const requestSha256 = await sha256File(requestPath);
    if (
      result.requestSha256 !== requestSha256 ||
      result.manifestId !== manifest.manifestId ||
      result.operation !== operation
    ) {
      return {
        status: operation === "rollback" ? "rollback_failed" : "failed",
        failureCode: "helper_result_binding_invalid",
      };
    }
    const evidenceRefs = [`source-update-helper-result:${manifest.manifestId}:sha256:${result.evidenceSha256}`];
    if (result.status === "succeeded" || result.status === "rolled_back") {
      if (!isGitObject(result.baselineSha) || !isGitObject(result.baselineTree)) {
        return {
          status: operation === "rollback" ? "rollback_failed" : "failed",
          failureCode: "helper_result_baseline_invalid",
          evidenceRefs,
        };
      }
      return {
        status: result.status,
        baselineSha: result.baselineSha,
        baselineTree: result.baselineTree,
        evidenceRefs,
      };
    }
    return { status: result.status, failureCode: safeFailureCode(result.failureCode), evidenceRefs };
  }

  private async readRawResult(
    manifest: ProductSourceUpdateManifestRecord,
    operation: "apply" | "rollback",
  ): Promise<HelperResult | undefined> {
    const resultPath = this.paths(manifest, operation).result;
    let raw: string;
    try {
      raw = await fs.readFile(resultPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > 64 * 1_024)
      throw new ConflictError({ message: "Native helper result exceeds its bounded contract." });
    const parsed = JSON.parse(raw) as Partial<HelperResult>;
    if (
      parsed.schemaVersion !== 1 ||
      !["apply", "rollback"].includes(parsed.operation ?? "") ||
      !["succeeded", "rolled_back", "failed", "rollback_failed"].includes(parsed.status ?? "") ||
      !isSha256(parsed.requestSha256) ||
      !isSha256(parsed.evidenceSha256) ||
      !parsed.finishedAt ||
      !Number.isFinite(Date.parse(parsed.finishedAt))
    ) {
      throw new ConflictError({ message: "Native helper result failed contract validation." });
    }
    return parsed as HelperResult;
  }

  private async hasRequest(
    manifest: ProductSourceUpdateManifestRecord,
    operation: "apply" | "rollback",
  ): Promise<boolean> {
    try {
      return (await fs.lstat(this.paths(manifest, operation).request)).isFile();
    } catch {
      return false;
    }
  }

  private async resumePendingRequest(
    manifest: ProductSourceUpdateManifestRecord,
    operation: "apply" | "rollback",
  ): Promise<ProductSourceApplyObservation> {
    try {
      const paths = this.paths(manifest, operation);
      const raw = await fs.readFile(paths.request, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 4 * 1_024 * 1_024) {
        throw new ConflictError({ message: "Native helper request exceeds its bounded contract." });
      }
      const request = JSON.parse(raw) as Partial<HelperRequest>;
      if (
        request.schemaVersion !== 1 ||
        request.operation !== operation ||
        request.planId !== manifest.planId ||
        request.manifestId !== manifest.manifestId ||
        request.manifestSha256 !== manifest.manifestSha256 ||
        request.installId !== manifest.installId ||
        request.installRevision !== manifest.installRevision ||
        request.resultPath !== paths.result ||
        request.journalPath !== paths.journal ||
        !request.createdAt ||
        !Number.isFinite(Date.parse(request.createdAt)) ||
        !Number.isSafeInteger(request.parentPid) ||
        !Number.isSafeInteger(request.parentStartedAtUnixMs) ||
        !Array.isArray(request.approvalIds) ||
        request.approvalIds.length < 1
      ) {
        throw new ConflictError({ message: "Native helper request failed recovery binding validation." });
      }
      const ageMs = Math.max(0, this.now() - Date.parse(request.createdAt));
      const requestSha256 = sha256(raw);
      const evidenceRefs = [`source-update-helper-request:${manifest.manifestId}:sha256:${requestSha256}`];
      if (ageMs >= this.pendingFailAfterMs) {
        return {
          status: operation === "rollback" ? "rollback_failed" : "failed",
          failureCode: "native_helper_result_timeout",
          evidenceRefs,
        };
      }
      if (ageMs >= this.pendingRelaunchAfterMs) {
        const configuration = await this.requireConfiguration();
        if (canonicalJsonString(request.restart) !== canonicalJsonString(configuration.restart)) {
          throw new ConflictError({
            message: "The installation-owned restart descriptor changed during helper recovery.",
          });
        }
        await configuration.launch(configuration.helperPath, [
          "--request",
          paths.request,
          "--request-sha256",
          requestSha256,
        ]);
      }
      return { status: "running", evidenceRefs };
    } catch (error) {
      return {
        status: operation === "rollback" ? "rollback_failed" : "failed",
        failureCode: helperFailureCode(error),
      };
    }
  }

  private paths(manifest: ProductSourceUpdateManifestRecord, operation: "apply" | "rollback") {
    const artifact = resolvePrivatePath(this.rootDir, manifest.patchArtifactRelPath);
    const directory = path.dirname(artifact);
    return {
      request: path.join(directory, `${operation}-helper-request.json`),
      result: path.join(directory, `${operation}-helper-result.json`),
      journal: path.join(directory, "native-helper-journal.jsonl"),
    };
  }
}

function reverseChangedFiles(files: readonly ProductSourceChangedFileRecord[]): ProductSourceChangedFileRecord[] {
  return files.map((file) => ({
    path: file.path,
    changeKind: file.changeKind === "added" ? "deleted" : file.changeKind === "deleted" ? "added" : file.changeKind,
    ...(file.afterSha256 ? { beforeSha256: file.afterSha256 } : {}),
    ...(file.beforeSha256 ? { afterSha256: file.beforeSha256 } : {}),
  }));
}

function resolvePrivatePath(rootDir: string, relativePath: string): string {
  const target = path.resolve(rootDir, ...relativePath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(rootDir, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SemanticValidationError("Native helper artifact path escapes the Gateway-owned path jail.");
  }
  return target;
}

function normalizeRestart(input: ProductSourceRestartDescriptor): ProductSourceRestartDescriptor {
  const executable = path.resolve(input.executable);
  const workingDirectory = path.resolve(input.workingDirectory);
  const healthUrl = new URL(input.healthUrl);
  if (healthUrl.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(healthUrl.hostname)) {
    throw new SemanticValidationError("Source-update smoke checks require a loopback HTTP health endpoint.");
  }
  const args = input.args.map((item) => {
    if (!item || item.length > 4_096 || /[\0\r\n]/u.test(item))
      throw new SemanticValidationError("Source-update restart arguments are invalid.");
    return item;
  });
  const healthTimeoutMs = input.healthTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs < 5_000 || healthTimeoutMs > 10 * 60_000) {
    throw new SemanticValidationError("Source-update smoke timeout is outside the supported bound.");
  }
  return { executable, args, workingDirectory, healthUrl: healthUrl.toString(), healthTimeoutMs };
}

async function launchDetached(helperPath: string, args: readonly string[]): Promise<void> {
  const child = spawn(helperPath, [...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function writeImmutable(target: string, content: string): Promise<void> {
  try {
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(target, "utf8")) !== content)
      throw new ConflictError({ message: "Native helper request path already contains different immutable bytes." });
  }
}

async function sha256File(target: string): Promise<string> {
  return sha256(await fs.readFile(target));
}

function helperFailureCode(error: unknown): string {
  if (error instanceof ConflictError) return "native_helper_binding_conflict";
  if (error instanceof SemanticValidationError) return "native_helper_unavailable";
  return "native_helper_launch_failed";
}

function safeFailureCode(value: string | undefined): string {
  return value && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : "native_helper_failed";
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isSha256(normalized))
    throw new SemanticValidationError("The native source-update helper identity hash is invalid.");
  return normalized;
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Native helper recovery duration must be between ${minimum} and ${maximum} ms.`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value.toLowerCase());
}

function isGitObject(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value.toLowerCase());
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
