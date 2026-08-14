import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type ManagedSourceInstallStatus = "candidate" | "active" | "revoked";

export interface ManagedSourceInstallRecord {
  readonly installId: string;
  readonly label: string;
  /** Sensitive native path. Never include this record in a public API projection. */
  readonly canonicalRoot: string;
  readonly repositoryIdentitySha256: string;
  readonly baselineSha: string;
  readonly baselineTree: string;
  readonly platform: "win32" | "darwin" | "linux";
  readonly volumeId: string;
  readonly status: ManagedSourceInstallStatus;
  readonly revision: number;
  readonly registeredAt: string;
  readonly lastVerifiedAt: string;
  readonly updatedAt: string;
}

interface Row {
  install_id: string;
  label: string;
  canonical_root: string;
  repository_identity_sha256: string;
  baseline_sha: string;
  baseline_tree: string;
  platform: ManagedSourceInstallRecord["platform"];
  volume_id: string;
  status: ManagedSourceInstallStatus;
  revision: number | string;
  registered_at: string;
  last_verified_at: string;
  updated_at: string;
}

export const MANAGED_SOURCE_INSTALL_SQL = `
  CREATE TABLE IF NOT EXISTS managed_source_installs (
    install_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    repository_identity_sha256 TEXT NOT NULL,
    baseline_sha TEXT NOT NULL,
    baseline_tree TEXT NOT NULL,
    platform TEXT NOT NULL CHECK(platform IN ('win32', 'darwin', 'linux')),
    volume_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'revoked')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    registered_at TEXT NOT NULL,
    last_verified_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_source_installs_one_active
    ON managed_source_installs(status) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_managed_source_installs_status_updated
    ON managed_source_installs(status, updated_at DESC, install_id DESC);
`;

export class ManagedSourceInstallRepository {
  private readonly getStmt;
  private readonly activeStmt;
  private readonly insertStmt;
  private readonly activateStmt;
  private readonly refreshStmt;
  private readonly revokeStmt;
  private readonly deleteCandidateStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM managed_source_installs WHERE install_id = ?");
    this.activeStmt = db.prepare("SELECT * FROM managed_source_installs WHERE status = 'active' LIMIT 1");
    this.insertStmt = db.prepare(`
      INSERT INTO managed_source_installs (
        install_id, label, canonical_root, repository_identity_sha256, baseline_sha, baseline_tree,
        platform, volume_id, status, revision, registered_at, last_verified_at, updated_at
      ) VALUES (
        @installId, @label, @canonicalRoot, @repositoryIdentitySha256, @baselineSha, @baselineTree,
        @platform, @volumeId, 'candidate', 1, @registeredAt, @lastVerifiedAt, @updatedAt
      )
    `);
    this.activateStmt = db.prepare(`
      UPDATE managed_source_installs
      SET status = 'active', revision = revision + 1, last_verified_at = @lastVerifiedAt, updated_at = @updatedAt
      WHERE install_id = @installId AND revision = @expectedRevision AND status = 'candidate'
    `);
    this.refreshStmt = db.prepare(`
      UPDATE managed_source_installs
      SET baseline_sha = @baselineSha, baseline_tree = @baselineTree,
          revision = revision + 1, last_verified_at = @lastVerifiedAt, updated_at = @updatedAt
      WHERE install_id = @installId AND revision = @expectedRevision AND status = 'active'
    `);
    this.revokeStmt = db.prepare(`
      UPDATE managed_source_installs
      SET status = 'revoked', revision = revision + 1, updated_at = @updatedAt
      WHERE install_id = @installId AND revision = @expectedRevision AND status <> 'revoked'
    `);
    this.deleteCandidateStmt = db.prepare(`
      DELETE FROM managed_source_installs
      WHERE install_id = @installId AND revision = @expectedRevision AND status = 'candidate'
    `);
  }

  public createCandidate(
    input: Omit<
      ManagedSourceInstallRecord,
      "installId" | "status" | "revision" | "registeredAt" | "lastVerifiedAt" | "updatedAt"
    >,
  ): ManagedSourceInstallRecord {
    validateInput(input);
    const installId = randomUUID();
    const now = new Date().toISOString();
    this.insertStmt.run({ installId, ...input, registeredAt: now, lastVerifiedAt: now, updatedAt: now });
    return this.get(installId);
  }

  public get(installId: string): ManagedSourceInstallRecord {
    const row = this.getStmt.get(identifier(installId, "installId")) as Row | undefined;
    if (!row) throw new NotFoundError({ entity: "Managed source install", id: installId });
    return mapRow(row);
  }

  public getActive(): ManagedSourceInstallRecord | undefined {
    const row = this.activeStmt.get() as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  public activate(installId: string, expectedRevision: number): ManagedSourceInstallRecord {
    return this.db.transaction("immediate", () => {
      const current = this.get(installId);
      assertRevision(current, expectedRevision);
      const active = this.getActive();
      if (active && active.installId !== current.installId) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "GoatCitadel v1 supports one active managed source install.",
        });
      }
      const now = new Date().toISOString();
      const result = this.activateStmt.run({
        installId: current.installId,
        expectedRevision,
        lastVerifiedAt: now,
        updatedAt: now,
      });
      if (Number(result.changes) !== 1) throw stale(current.installId, expectedRevision);
      return this.get(current.installId);
    });
  }

  public refreshBaseline(
    installId: string,
    input: { expectedRevision: number; baselineSha: string; baselineTree: string },
  ): ManagedSourceInstallRecord {
    const current = this.get(installId);
    assertRevision(current, input.expectedRevision);
    gitObject(input.baselineSha, "baselineSha");
    gitObject(input.baselineTree, "baselineTree");
    const now = new Date().toISOString();
    const result = this.refreshStmt.run({
      installId: current.installId,
      expectedRevision: input.expectedRevision,
      baselineSha: input.baselineSha,
      baselineTree: input.baselineTree,
      lastVerifiedAt: now,
      updatedAt: now,
    });
    if (Number(result.changes) !== 1) throw stale(current.installId, input.expectedRevision);
    return this.get(current.installId);
  }

  public revoke(installId: string, expectedRevision: number): ManagedSourceInstallRecord {
    const current = this.get(installId);
    assertRevision(current, expectedRevision);
    const result = this.revokeStmt.run({
      installId: current.installId,
      expectedRevision,
      updatedAt: new Date().toISOString(),
    });
    if (Number(result.changes) !== 1) throw stale(current.installId, expectedRevision);
    return this.get(current.installId);
  }

  public deleteCandidate(installId: string, expectedRevision: number): boolean {
    const result = this.deleteCandidateStmt.run({
      installId: identifier(installId, "installId"),
      expectedRevision: positive(expectedRevision),
    });
    return Number(result.changes) === 1;
  }
}

function mapRow(row: Row): ManagedSourceInstallRecord {
  return {
    installId: identifier(row.install_id, "installId"),
    label: bounded(row.label, "label", 160),
    canonicalRoot: bounded(row.canonical_root, "canonicalRoot", 4_096),
    repositoryIdentitySha256: sha256(row.repository_identity_sha256),
    baselineSha: gitObject(row.baseline_sha, "baselineSha"),
    baselineTree: gitObject(row.baseline_tree, "baselineTree"),
    platform: row.platform,
    volumeId: bounded(row.volume_id, "volumeId", 256),
    status: row.status,
    revision: positive(row.revision),
    registeredAt: timestamp(row.registered_at),
    lastVerifiedAt: timestamp(row.last_verified_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function validateInput(
  input: Omit<
    ManagedSourceInstallRecord,
    "installId" | "status" | "revision" | "registeredAt" | "lastVerifiedAt" | "updatedAt"
  >,
): void {
  bounded(input.label, "label", 160);
  bounded(input.canonicalRoot, "canonicalRoot", 4_096);
  sha256(input.repositoryIdentitySha256);
  gitObject(input.baselineSha, "baselineSha");
  gitObject(input.baselineTree, "baselineTree");
  if (!(["win32", "darwin", "linux"] as const).includes(input.platform))
    throw new TypeError("Managed source platform is invalid.");
  bounded(input.volumeId, "volumeId", 256);
}

function assertRevision(record: ManagedSourceInstallRecord, expected: number): void {
  if (record.revision !== positive(expected)) throw stale(record.installId, expected);
}

function stale(installId: string, expectedRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "Managed source install changed after it was inspected.",
    details: { resourceKind: "managed_source_install", resourceId: installId, expectedRevision },
  });
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(normalized))
    throw new TypeError(`Managed source ${label} is invalid.`);
  return normalized;
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0\r\n]/u.test(normalized))
    throw new TypeError(`Managed source ${label} is invalid.`);
  return normalized;
}

function sha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new TypeError("Managed source identity hash is invalid.");
  return normalized;
}

function gitObject(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) throw new TypeError(`Managed source ${label} is invalid.`);
  return normalized;
}

function positive(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("Managed source revision is invalid.");
  return parsed;
}

function timestamp(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new TypeError("Managed source timestamp is invalid.");
  return value;
}
