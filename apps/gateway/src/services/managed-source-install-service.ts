import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ConflictError, SemanticValidationError, canonicalJsonString } from "@goatcitadel/contracts";
import type { ManagedSourceInstallRecord } from "@goatcitadel/storage";

const execFileAsync = promisify(execFile);
const REQUIRED_MARKERS = [
  "package.json",
  "pnpm-workspace.yaml",
  "apps/gateway/package.json",
  "apps/mission-control-next/package.json",
  "docs/1_0_CONTRACT.md",
] as const;

export interface ManagedSourceInstallRepositoryPort {
  createCandidate(
    input: Omit<
      ManagedSourceInstallRecord,
      "installId" | "status" | "revision" | "registeredAt" | "lastVerifiedAt" | "updatedAt"
    >,
  ): ManagedSourceInstallRecord | Promise<ManagedSourceInstallRecord>;
  get(installId: string): ManagedSourceInstallRecord | Promise<ManagedSourceInstallRecord>;
  getActive(): ManagedSourceInstallRecord | undefined | Promise<ManagedSourceInstallRecord | undefined>;
  activate(
    installId: string,
    expectedRevision: number,
  ): ManagedSourceInstallRecord | Promise<ManagedSourceInstallRecord>;
  refreshBaseline(
    installId: string,
    input: { expectedRevision: number; baselineSha: string; baselineTree: string },
  ): ManagedSourceInstallRecord | Promise<ManagedSourceInstallRecord>;
  deleteCandidate(installId: string, expectedRevision: number): boolean | Promise<boolean>;
}

export interface ManagedSourceInspection {
  readonly canonicalRoot: string;
  readonly label: string;
  readonly repositoryIdentitySha256: string;
  readonly baselineSha: string;
  readonly baselineTree: string;
  readonly platform: ManagedSourceInstallRecord["platform"];
  readonly volumeId: string;
}

export interface ManagedSourceInstallPublicProjection {
  readonly installId: string;
  readonly label: string;
  readonly baselineSha: string;
  readonly baselineTree: string;
  readonly platform: ManagedSourceInstallRecord["platform"];
  readonly status: ManagedSourceInstallRecord["status"];
  readonly revision: number;
  readonly liveApplySupported: boolean;
  readonly lastVerifiedAt: string;
}

export class ManagedSourceInstallService {
  public constructor(
    private readonly repository: ManagedSourceInstallRepositoryPort,
    private readonly inspectRoot: (root: string) => Promise<ManagedSourceInspection> = inspectGoatCitadelSourceRoot,
  ) {}

  public async stageCandidate(root: string): Promise<ManagedSourceInstallRecord> {
    if (await this.repository.getActive()) {
      throw new ConflictError({
        message: "A managed GoatCitadel source install is already active. Revoke it before registering another.",
      });
    }
    const inspected = await this.inspectRoot(requireNativePath(root));
    return await this.repository.createCandidate(inspected);
  }

  public async activateCandidate(installId: string, expectedRevision: number): Promise<ManagedSourceInstallRecord> {
    const candidate = await this.repository.get(installId);
    if (candidate.status !== "candidate" || candidate.revision !== expectedRevision) {
      throw new ConflictError({ message: "Managed source candidate changed before confirmation." });
    }
    const current = await this.inspectRoot(candidate.canonicalRoot);
    assertSameInspection(candidate, current);
    return await this.repository.activate(candidate.installId, candidate.revision);
  }

  public async inspectRegistered(installId: string): Promise<{
    record: ManagedSourceInstallRecord;
    current: ManagedSourceInspection;
    matchesBaseline: boolean;
  }> {
    const record = await this.repository.get(installId);
    const current = await this.inspectRoot(record.canonicalRoot);
    return {
      record,
      current,
      matchesBaseline:
        record.repositoryIdentitySha256 === current.repositoryIdentitySha256 &&
        record.baselineSha === current.baselineSha &&
        record.baselineTree === current.baselineTree,
    };
  }

  /**
   * Advances the private registration only after the native apply owner has
   * produced a clean committed Git state and the complete install identity is
   * re-inspected. This is idempotent for restart reconciliation.
   */
  public async acceptAppliedBaseline(input: {
    installId: string;
    expectedRevision: number;
    expectedPreviousSha: string;
    baselineSha: string;
    baselineTree: string;
  }): Promise<ManagedSourceInstallRecord> {
    const record = await this.repository.get(input.installId);
    if (
      record.revision === input.expectedRevision + 1 &&
      record.baselineSha === input.baselineSha &&
      record.baselineTree === input.baselineTree &&
      record.status === "active"
    ) {
      return record;
    }
    if (
      record.status !== "active" ||
      record.revision !== input.expectedRevision ||
      record.baselineSha !== input.expectedPreviousSha
    ) {
      throw new ConflictError({
        message: "Managed source registration changed before the applied baseline could be accepted.",
      });
    }
    const current = await this.inspectRoot(record.canonicalRoot);
    if (
      current.canonicalRoot !== record.canonicalRoot ||
      current.repositoryIdentitySha256 !== record.repositoryIdentitySha256 ||
      current.platform !== record.platform ||
      current.volumeId !== record.volumeId ||
      current.baselineSha !== input.baselineSha ||
      current.baselineTree !== input.baselineTree
    ) {
      throw new ConflictError({
        message: "The native source-update result does not match the clean registered repository state.",
      });
    }
    return await this.repository.refreshBaseline(record.installId, {
      expectedRevision: record.revision,
      baselineSha: input.baselineSha,
      baselineTree: input.baselineTree,
    });
  }

  public async discardCandidate(installId: string, expectedRevision: number): Promise<void> {
    await this.repository.deleteCandidate(installId, expectedRevision);
  }

  public project(record: ManagedSourceInstallRecord): ManagedSourceInstallPublicProjection {
    return {
      installId: record.installId,
      label: record.label,
      baselineSha: record.baselineSha,
      baselineTree: record.baselineTree,
      platform: record.platform,
      status: record.status,
      revision: record.revision,
      liveApplySupported: record.platform === "win32",
      lastVerifiedAt: record.lastVerifiedAt,
    };
  }
}

export async function inspectGoatCitadelSourceRoot(rootInput: string): Promise<ManagedSourceInspection> {
  const absolute = path.resolve(requireNativePath(rootInput));
  if (!path.isAbsolute(absolute) || absolute === path.parse(absolute).root) {
    throw invalidRoot("Select the GoatCitadel repository root, not a drive or filesystem root.");
  }
  const canonicalRoot = await fs.realpath(absolute);
  if (path.normalize(canonicalRoot) !== path.normalize(absolute)) {
    throw invalidRoot("Managed source roots cannot be aliases, symlinks, junctions, or reparse redirects.");
  }
  await assertNoFollowAncestors(canonicalRoot);
  const gitStat = await fs.lstat(path.join(canonicalRoot, ".git"));
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    throw invalidRoot("Managed source registration requires a primary Git checkout with a real .git directory.");
  }
  for (const marker of REQUIRED_MARKERS) {
    const markerPath = path.join(canonicalRoot, ...marker.split("/"));
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw invalidRoot(`Required GoatCitadel marker ${marker} is missing or unsafe.`);
    }
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(canonicalRoot, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  if (packageJson.name !== "goatcitadel") throw invalidRoot("The selected repository is not GoatCitadel.");

  const topLevel = await git(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (path.normalize(await fs.realpath(topLevel)) !== path.normalize(canonicalRoot)) {
    throw invalidRoot("Git reports a different repository root than the selected source install.");
  }
  const status = await git(canonicalRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.length > 0)
    throw invalidRoot("Managed source registration requires a clean checkout, including no untracked files.");
  const baselineSha = requireGitObject(await git(canonicalRoot, ["rev-parse", "HEAD"]));
  const baselineTree = requireGitObject(await git(canonicalRoot, ["rev-parse", "HEAD^{tree}"]));
  const remote = await git(canonicalRoot, ["remote", "get-url", "origin"]);
  if (!remote) throw invalidRoot("Managed source registration requires an origin repository identity.");
  const { platform, volumeId } = await inspectFixedVolume(canonicalRoot);
  const repositoryIdentitySha256 = sha256(
    canonicalJsonString({
      product: "goatcitadel",
      remote: normalizeRemote(remote),
      markers: REQUIRED_MARKERS,
    }),
  );
  return {
    canonicalRoot,
    label: path.basename(canonicalRoot),
    repositoryIdentitySha256,
    baselineSha,
    baselineTree,
    platform,
    volumeId,
  };
}

async function assertNoFollowAncestors(root: string): Promise<void> {
  const parsed = path.parse(root);
  const relative = path.relative(parsed.root, root);
  let cursor = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink())
      throw invalidRoot("Managed source path ancestry contains a symlink, junction, or reparse redirect.");
  }
}

async function inspectFixedVolume(root: string): Promise<{
  platform: ManagedSourceInstallRecord["platform"];
  volumeId: string;
}> {
  if (process.platform !== "win32") {
    throw invalidRoot("Managed source registration currently requires the Windows fixed-volume verifier.");
  }
  if (root.startsWith("\\\\"))
    throw invalidRoot("Network and UNC paths cannot be registered as managed source installs.");
  const drive = path.parse(root).root.slice(0, 2).toUpperCase();
  if (!/^[A-Z]:$/u.test(drive)) throw invalidRoot("Managed source root has no canonical local drive.");
  const command = `$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if($null -eq $disk){exit 4}; "$($disk.DriveType)|$($disk.VolumeSerialNumber)"`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 16_384,
  });
  const [driveType, serial] = stdout.trim().split("|");
  if (driveType !== "3" || !serial?.trim()) throw invalidRoot("Managed source installs require a fixed local volume.");
  return { platform: "win32", volumeId: sha256(`${drive}|${serial.trim()}`) };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 4 * 1_024 * 1_024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch {
    throw invalidRoot("The selected source root failed a required local Git identity or cleanliness check.");
  }
}

function assertSameInspection(record: ManagedSourceInstallRecord, inspection: ManagedSourceInspection): void {
  if (
    record.canonicalRoot !== inspection.canonicalRoot ||
    record.repositoryIdentitySha256 !== inspection.repositoryIdentitySha256 ||
    record.baselineSha !== inspection.baselineSha ||
    record.baselineTree !== inspection.baselineTree ||
    record.platform !== inspection.platform ||
    record.volumeId !== inspection.volumeId
  ) {
    throw new ConflictError({
      message: "Managed source root changed after it was selected. Register a fresh clean baseline.",
    });
  }
}

function requireNativePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || /[\0\r\n]/u.test(value)) {
    throw invalidRoot("Managed source path is invalid.");
  }
  return value.trim();
}

function requireGitObject(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) throw invalidRoot("Git returned an invalid source revision.");
  return normalized;
}

function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\.git$/u, "")
    .toLowerCase();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidRoot(message: string): SemanticValidationError {
  return new SemanticValidationError(message);
}
