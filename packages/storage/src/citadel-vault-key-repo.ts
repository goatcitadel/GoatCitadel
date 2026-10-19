import { randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  CITADEL_VAULT_TERMINAL_ROTATION_PHASES,
  VAULT_ERROR_CODES,
  type CitadelVaultRotationPhase,
  type CitadelVaultRotationView,
  type SealedValue,
  type SealedValueV2,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { advanceCitadelVaultGeneration, assertBoundEnvelope, vaultScopeKey } from "./citadel-vault-shared.js";
import { safeJsonParse } from "./safe-json.js";

// Ciphertext-only owner of the Vault key hierarchy (design §5.4): wrapped data
// keys, per-Citadel key state and the rotation ledger. It never sees plaintext,
// a data key or a key-encryption key; the Gateway does all crypto and sends
// ciphertext commands guarded by compare-and-set.

export interface VaultKeyRow {
  keyId: string;
  citadelId: string;
  chamberId: string | null;
  dekVersion: number;
  kekVersion: number;
  wrappedDek: SealedValue;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultKeyStateRow {
  citadelId: string;
  kekVersion: number;
  legacyReadsClosed: boolean;
  kekCreatedAt: string;
  kekRotatedAt?: string;
  updatedAt: string;
}

export interface VaultSealedRow {
  secretId: string;
  citadelId: string;
  chamberId: string | null;
  keyId: string | null;
  envelopeVersion: 1 | 2;
  sealedValueJson: string;
}

export interface VaultRotationRow extends CitadelVaultRotationView {
  citadelId: string;
  fromKeyId?: string;
  toKeyId?: string;
  fromKekVersion?: number;
  toKekVersion?: number;
  requestedBy: string;
  reason: string;
}

export interface VaultResealItem {
  secretId: string;
  expectSealedJson: string;
  /** null = the row must still be a legacy v1 envelope. */
  expectKeyId: string | null;
  next: SealedValueV2;
}

export interface VaultRotationPatch {
  phase?: CitadelVaultRotationPhase;
  approvalId?: string;
  resealedCount?: number;
  totalCount?: number;
  lastErrorCode?: string | null;
  fromKekVersion?: number;
  toKekVersion?: number;
}

interface VaultKeyContext {
  withLock<T>(citadelId: string, action: () => T): T;
}

interface KeyRowDb {
  key_id: string;
  citadel_id: string;
  chamber_id: string | null;
  active_scope_key: string | null;
  dek_version: number | string;
  kek_version: number | string;
  wrapped_dek_json: string;
  created_at: string;
  updated_at: string;
}

interface RotationRowDb {
  rotation_id: string;
  citadel_id: string;
  target: string;
  chamber_id: string | null;
  from_key_id: string | null;
  to_key_id: string | null;
  from_kek_version: number | string | null;
  to_kek_version: number | string | null;
  phase: string;
  approval_id: string | null;
  requested_by: string;
  reason: string;
  resealed_count: number | string;
  total_count: number | string;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const ROTATION_PHASES = new Set<CitadelVaultRotationPhase>([
  "awaiting_approval",
  "approved",
  "resealing",
  "kek_staged",
  "rewrapped",
  "completed",
  "cancelled",
  "failed",
]);

const scopeKeyOf = vaultScopeKey;

const KEY_CHANGED_PHASES = new Set<CitadelVaultRotationPhase>(["resealing", "kek_staged", "rewrapped"]);

function keyChanged(message: string): ConflictError {
  return new ConflictError({ code: "WRITE_CONFLICT", message, details: { reason: VAULT_ERROR_CODES.keyChanged } });
}

export class CitadelVaultKeyRepository {
  public constructor(
    private readonly db: DatabaseClient,
    private readonly context: VaultKeyContext,
  ) {}

  // --- key state -------------------------------------------------------------

  public getKeyState(citadelId: string): VaultKeyStateRow | undefined {
    const row = this.db.prepare("SELECT * FROM citadel_vault_key_state WHERE citadel_id = @citadelId").get<{
      citadel_id: string;
      kek_version: number | string;
      legacy_reads_closed: number | string;
      kek_created_at: string;
      kek_rotated_at: string | null;
      updated_at: string;
    }>({ citadelId });
    if (!row) return undefined;
    return {
      citadelId: row.citadel_id,
      kekVersion: Number(row.kek_version),
      legacyReadsClosed: Number(row.legacy_reads_closed) === 1,
      kekCreatedAt: row.kek_created_at,
      kekRotatedAt: row.kek_rotated_at ?? undefined,
      updatedAt: row.updated_at,
    };
  }

  /** Records the active KEK version for a Citadel; an existing row is updated (KEK regenerated after deletions). */
  public ensureKeyState(citadelId: string, kekVersion: number): VaultKeyStateRow {
    assertPositiveInteger(kekVersion, "KEK version");
    return this.context.withLock(citadelId, () => {
      const existing = this.getKeyState(citadelId);
      if (existing && existing.kekVersion !== kekVersion) {
        // A real KEK change is a rotation (rewrapAll). Only a Citadel with nothing sealed
        // may record a regenerated KEK, and only at a higher version.
        if (this.hasSealedData(citadelId)) {
          throw keyChanged("This Vault already holds sealed data. Change its key through rotation.");
        }
        if (kekVersion < existing.kekVersion) {
          throw new ValidationError({ message: "A Vault key version never moves backwards." });
        }
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO citadel_vault_key_state (citadel_id, kek_version, legacy_reads_closed, kek_created_at, updated_at)
        VALUES (@citadelId, @kekVersion, 0, @now, @now)
        ON CONFLICT (citadel_id) DO UPDATE SET kek_version = excluded.kek_version, kek_created_at = excluded.kek_created_at,
          updated_at = excluded.updated_at
        WHERE citadel_vault_key_state.kek_version <> excluded.kek_version`,
        )
        .run({ citadelId, kekVersion, now });
      return this.getKeyState(citadelId)!;
    });
  }

  /** Sets the flag only when no legacy v1 envelope remains, in the same transaction. */
  public closeLegacyReads(citadelId: string): boolean {
    return this.context.withLock(citadelId, () => {
      if (this.countLegacy(citadelId) > 0 || !this.getKeyState(citadelId)) return false;
      this.db
        .prepare(
          "UPDATE citadel_vault_key_state SET legacy_reads_closed = 1, updated_at = @now WHERE citadel_id = @citadelId",
        )
        .run({ citadelId, now: new Date().toISOString() });
      return true;
    });
  }

  public countLegacy(citadelId: string): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS count FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND envelope_version = 1",
        )
        .get<{ count: number | string }>({ citadelId })?.count ?? 0,
    );
  }

  /** True when the Citadel has any data key or any secret row: a KEK must already exist. */
  public hasSealedData(citadelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT
        (SELECT count(*) FROM citadel_vault_keys WHERE citadel_id = @citadelId) AS key_count,
        (SELECT count(*) FROM citadel_vault_secrets WHERE citadel_id = @citadelId) AS secret_count`,
      )
      .get<{ key_count: number | string; secret_count: number | string }>({ citadelId });
    return Number(row?.key_count ?? 0) + Number(row?.secret_count ?? 0) > 0;
  }

  // --- data keys -------------------------------------------------------------

  public listKeys(citadelId: string): VaultKeyRow[] {
    return this.db
      .prepare("SELECT * FROM citadel_vault_keys WHERE citadel_id = @citadelId ORDER BY scope_key ASC, dek_version ASC")
      .all<KeyRowDb>({ citadelId })
      .map(mapKey);
  }

  public getKey(citadelId: string, keyId: string): VaultKeyRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM citadel_vault_keys WHERE citadel_id = @citadelId AND key_id = @keyId")
      .get<KeyRowDb>({ citadelId, keyId });
    return row ? mapKey(row) : undefined;
  }

  public getActiveKey(citadelId: string, chamberId: string | null): VaultKeyRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM citadel_vault_keys WHERE citadel_id = @citadelId AND active_scope_key = @scopeKey")
      .get<KeyRowDb>({ citadelId, scopeKey: scopeKeyOf(chamberId) });
    return row ? mapKey(row) : undefined;
  }

  /** Creates a scope's first data key. A concurrent creator wins; the loser gets VAULT_KEY_CHANGED and re-reads. */
  public insertActiveKey(input: {
    citadelId: string;
    chamberId: string | null;
    keyId: string;
    dekVersion: number;
    kekVersion: number;
    wrappedDek: SealedValue;
  }): VaultKeyRow {
    return this.context.withLock(input.citadelId, () => {
      if (this.getActiveKey(input.citadelId, input.chamberId)) {
        throw keyChanged("This scope already has a data key. Reload the Vault and try again.");
      }
      this.assertCurrentKek(input.citadelId, input.kekVersion);
      this.insertKey(input, true);
      return this.getKey(input.citadelId, input.keyId)!;
    });
  }

  // --- sealed rows -----------------------------------------------------------

  /** Trusted read for the Gateway key service only: sealed envelopes, never routed to clients. */
  public readSealedRows(
    citadelId: string,
    filter: { keyId?: string; legacyOnly?: boolean; limit: number },
  ): VaultSealedRow[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(filter.limit)));
    const where = filter.legacyOnly ? "AND envelope_version = 1" : filter.keyId ? "AND key_id = @keyId" : "";
    return this.db
      .prepare(
        `SELECT secret_id, citadel_id, chamber_id, key_id, envelope_version, sealed_value_json
        FROM citadel_vault_secrets WHERE citadel_id = @citadelId ${where} ORDER BY secret_id ASC LIMIT ${limit}`,
      )
      .all<{
        secret_id: string;
        citadel_id: string;
        chamber_id: string | null;
        key_id: string | null;
        envelope_version: number | string;
        sealed_value_json: string;
      }>(filter.keyId && !filter.legacyOnly ? { citadelId, keyId: filter.keyId } : { citadelId })
      .map((row) => ({
        secretId: row.secret_id,
        citadelId: row.citadel_id,
        chamberId: row.chamber_id,
        keyId: row.key_id,
        envelopeVersion: Number(row.envelope_version) === 2 ? 2 : 1,
        sealedValueJson: row.sealed_value_json,
      }));
  }

  /**
   * Applies re-sealed envelopes with row-level compare-and-set. A row that changed
   * since it was read is skipped (that write already used the current key). The
   * target key must belong to the row's own scope. Does not consume a review.
   */
  public applyResealBatch(citadelId: string, items: readonly VaultResealItem[]): { applied: number; skipped: number } {
    return this.context.withLock(citadelId, () => {
      let applied = 0;
      for (const item of items) {
        assertBoundEnvelope(item.next);
        const row = this.db
          .prepare(
            "SELECT chamber_id FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND secret_id = @secretId",
          )
          .get<{ chamber_id: string | null }>({ citadelId, secretId: item.secretId });
        if (!row) continue;
        const key = this.getKey(citadelId, item.next.keyId);
        if (!key || key.chamberId !== row.chamber_id) {
          throw keyChanged("A re-sealed value names a data key outside its scope.");
        }
        const guard =
          item.expectKeyId === null ? "AND envelope_version = 1 AND key_id IS NULL" : "AND key_id = @expectKeyId";
        const result = this.db
          .prepare(
            `UPDATE citadel_vault_secrets
            SET sealed_value_json = @next, key_id = @keyId, envelope_version = 2
          WHERE citadel_id = @citadelId AND secret_id = @secretId AND sealed_value_json = @expect ${guard}`,
          )
          .run({
            citadelId,
            secretId: item.secretId,
            next: JSON.stringify(item.next),
            keyId: item.next.keyId,
            expect: item.expectSealedJson,
            ...(item.expectKeyId === null ? {} : { expectKeyId: item.expectKeyId }),
          });
        if (Number(result.changes) > 0) applied += 1;
      }
      return { applied, skipped: items.length - applied };
    });
  }

  // --- rotation ledger -------------------------------------------------------

  public createRotation(input: {
    citadelId: string;
    target: "dek" | "kek";
    chamberId: string | null;
    requestedBy: string;
    reason: string;
    fromKeyId?: string;
    fromKekVersion?: number;
  }): VaultRotationRow {
    if (input.target !== "dek" && input.target !== "kek")
      throw new ValidationError({ message: "Unsupported rotation target." });
    return this.context.withLock(input.citadelId, () => {
      if (this.getOpenRotation(input.citadelId)) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "A Vault key rotation is already in progress for this Citadel.",
          details: { reason: VAULT_ERROR_CODES.rotationInProgress },
        });
      }
      const hasKey =
        input.target === "kek"
          ? this.getKeyState(input.citadelId) !== undefined
          : this.getActiveKey(input.citadelId, input.chamberId) !== undefined;
      if (!hasKey) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "There is no key to rotate yet. A key is created when the first secret is stored.",
          details: { reason: VAULT_ERROR_CODES.noKeyToRotate },
        });
      }
      const rotationId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO citadel_vault_rotations (rotation_id, citadel_id, open_citadel_id, target, chamber_id,
          from_key_id, from_kek_version, phase, requested_by, reason, resealed_count, total_count, created_at, updated_at)
        VALUES (@rotationId, @citadelId, @citadelId, @target, @chamberId, @fromKeyId, @fromKekVersion, 'awaiting_approval',
          @requestedBy, @reason, 0, 0, @now, @now)`,
        )
        .run({
          rotationId,
          citadelId: input.citadelId,
          target: input.target,
          chamberId: input.target === "kek" ? null : input.chamberId,
          fromKeyId: input.fromKeyId ?? null,
          fromKekVersion: input.fromKekVersion ?? null,
          requestedBy: input.requestedBy,
          reason: input.reason,
          now,
        });
      return this.getRotation(input.citadelId, rotationId)!;
    });
  }

  public getRotation(citadelId: string, rotationId: string): VaultRotationRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM citadel_vault_rotations WHERE citadel_id = @citadelId AND rotation_id = @rotationId")
      .get<RotationRowDb>({ citadelId, rotationId });
    return row ? mapRotation(row) : undefined;
  }

  public getOpenRotation(citadelId: string): VaultRotationRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM citadel_vault_rotations WHERE open_citadel_id = @citadelId")
      .get<RotationRowDb>({ citadelId });
    return row ? mapRotation(row) : undefined;
  }

  /** Every non-terminal rotation, for boot recovery. */
  public listOpenRotations(): VaultRotationRow[] {
    return this.db
      .prepare("SELECT * FROM citadel_vault_rotations WHERE open_citadel_id IS NOT NULL ORDER BY created_at ASC")
      .all<RotationRowDb>({})
      .map(mapRotation);
  }

  /** Phase compare-and-set. Reaching a terminal phase closes the rotation; completion advances the review. */
  public advanceRotation(
    rotationId: string,
    fromPhase: CitadelVaultRotationPhase,
    patch: VaultRotationPatch,
  ): VaultRotationRow {
    const existing = this.db
      .prepare("SELECT citadel_id FROM citadel_vault_rotations WHERE rotation_id = @rotationId")
      .get<{ citadel_id: string }>({ rotationId });
    if (!existing) throw new NotFoundError({ entity: "Vault key rotation" });
    if (patch.phase && !ROTATION_PHASES.has(patch.phase))
      throw new ValidationError({ message: "Unsupported rotation phase." });
    // Once key material changed, only resume can finish a rotation; it never becomes terminal-failed.
    if ((patch.phase === "failed" || patch.phase === "cancelled") && KEY_CHANGED_PHASES.has(fromPhase)) {
      throw new ValidationError({ message: "A rotation that already changed keys can only be resumed." });
    }
    return this.context.withLock(existing.citadel_id, () =>
      this.updateRotation(existing.citadel_id, rotationId, fromPhase, patch),
    );
  }

  /**
   * Approved → resealing in one transaction: the current data key stops being
   * active (it stays, to open rows that still name it) and the new one becomes active.
   */
  public startDekRotation(
    rotationId: string,
    next: { keyId: string; dekVersion: number; kekVersion: number; wrappedDek: SealedValue },
  ): VaultRotationRow {
    const rotation = this.requireRotation(rotationId);
    if (rotation.target !== "dek") throw new ValidationError({ message: "This rotation does not rotate a data key." });
    return this.context.withLock(rotation.citadelId, () => {
      const current = this.getActiveKey(rotation.citadelId, rotation.chamberId);
      if (!current || next.dekVersion !== current.dekVersion + 1) {
        throw keyChanged("The scope's data key changed. Reload the Vault and try again.");
      }
      this.assertCurrentKek(rotation.citadelId, next.kekVersion);
      this.db
        .prepare("UPDATE citadel_vault_keys SET active_scope_key = NULL, updated_at = @now WHERE key_id = @keyId")
        .run({ keyId: current.keyId, now: new Date().toISOString() });
      this.insertKey({ citadelId: rotation.citadelId, chamberId: rotation.chamberId, ...next }, true);
      const total = Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND key_id = @keyId",
          )
          .get<{ count: number | string }>({ citadelId: rotation.citadelId, keyId: current.keyId })?.count ?? 0,
      );
      this.db
        .prepare(
          "UPDATE citadel_vault_rotations SET from_key_id = @fromKeyId, to_key_id = @toKeyId WHERE rotation_id = @rotationId",
        )
        .run({ rotationId, fromKeyId: current.keyId, toKeyId: next.keyId });
      return this.updateRotation(rotation.citadelId, rotationId, "approved", {
        phase: "resealing",
        totalCount: total,
        resealedCount: 0,
      });
    });
  }

  /** Shreds the retiring data key once no secret names it, and completes the rotation. */
  public finishDekRotation(rotationId: string): boolean {
    const rotation = this.requireRotation(rotationId);
    return this.context.withLock(rotation.citadelId, () => {
      const current = this.getRotation(rotation.citadelId, rotationId)!;
      if (current.phase !== "resealing" || !current.fromKeyId) return false;
      const remaining = Number(
        this.db
          .prepare(
            "SELECT count(*) AS count FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND key_id = @keyId",
          )
          .get<{ count: number | string }>({ citadelId: current.citadelId, keyId: current.fromKeyId })?.count ?? 0,
      );
      if (remaining > 0) return false;
      this.db
        .prepare(
          "DELETE FROM citadel_vault_keys WHERE citadel_id = @citadelId AND key_id = @keyId AND active_scope_key IS NULL",
        )
        .run({ citadelId: current.citadelId, keyId: current.fromKeyId });
      this.updateRotation(current.citadelId, rotationId, "resealing", {
        phase: "completed",
        resealedCount: current.totalCount,
      });
      return true;
    });
  }

  /** kek_staged → rewrapped: every data key of the Citadel is re-wrapped and the KEK version advances together. */
  public rewrapAll(
    rotationId: string,
    rewrapped: ReadonlyArray<{ keyId: string; wrappedDek: SealedValue }>,
  ): VaultRotationRow {
    const rotation = this.requireRotation(rotationId);
    if (rotation.target !== "kek" || rotation.toKekVersion === undefined) {
      throw new ValidationError({ message: "This rotation does not rotate the Citadel key." });
    }
    const toKekVersion = rotation.toKekVersion;
    return this.context.withLock(rotation.citadelId, () => {
      const keys = this.listKeys(rotation.citadelId);
      const byId = new Map(rewrapped.map((entry) => [entry.keyId, entry.wrappedDek]));
      if (byId.size !== rewrapped.length || keys.length !== byId.size || keys.some((key) => !byId.has(key.keyId))) {
        throw keyChanged("The Citadel's data keys changed during rotation. Resume to re-read them.");
      }
      const now = new Date().toISOString();
      for (const key of keys) {
        this.db
          .prepare(
            "UPDATE citadel_vault_keys SET wrapped_dek_json = @wrapped, kek_version = @kekVersion, updated_at = @now WHERE key_id = @keyId",
          )
          .run({ keyId: key.keyId, wrapped: JSON.stringify(byId.get(key.keyId)), kekVersion: toKekVersion, now });
      }
      this.db
        .prepare(
          `UPDATE citadel_vault_key_state SET kek_version = @kekVersion, kek_rotated_at = @now, updated_at = @now
        WHERE citadel_id = @citadelId`,
        )
        .run({ citadelId: rotation.citadelId, kekVersion: toKekVersion, now });
      return this.updateRotation(rotation.citadelId, rotationId, "kek_staged", { phase: "rewrapped" });
    });
  }

  // --- internals -------------------------------------------------------------

  /** A new data key must be wrapped under the Citadel's current KEK version. */
  private assertCurrentKek(citadelId: string, kekVersion: number): void {
    if (this.getKeyState(citadelId)?.kekVersion !== kekVersion) {
      throw keyChanged("The Citadel key changed. Wrap the data key under the current key and try again.");
    }
  }

  private requireRotation(rotationId: string): VaultRotationRow {
    const row = this.db
      .prepare("SELECT * FROM citadel_vault_rotations WHERE rotation_id = @rotationId")
      .get<RotationRowDb>({ rotationId });
    if (!row) throw new NotFoundError({ entity: "Vault key rotation" });
    return mapRotation(row);
  }

  private insertKey(
    input: {
      citadelId: string;
      chamberId: string | null;
      keyId: string;
      dekVersion: number;
      kekVersion: number;
      wrappedDek: SealedValue;
    },
    active: boolean,
  ): void {
    assertPositiveInteger(input.dekVersion, "data key version");
    assertPositiveInteger(input.kekVersion, "KEK version");
    const now = new Date().toISOString();
    const scopeKey = scopeKeyOf(input.chamberId);
    this.db
      .prepare(
        `INSERT INTO citadel_vault_keys (key_id, citadel_id, chamber_id, scope_key, active_scope_key, dek_version,
        kek_version, wrapped_dek_json, created_at, updated_at)
      VALUES (@keyId, @citadelId, @chamberId, @scopeKey, @activeScopeKey, @dekVersion, @kekVersion, @wrapped, @now, @now)`,
      )
      .run({
        keyId: input.keyId,
        citadelId: input.citadelId,
        chamberId: input.chamberId,
        scopeKey,
        activeScopeKey: active ? scopeKey : null,
        dekVersion: input.dekVersion,
        kekVersion: input.kekVersion,
        wrapped: JSON.stringify(input.wrappedDek),
        now,
      });
  }

  private updateRotation(
    citadelId: string,
    rotationId: string,
    fromPhase: CitadelVaultRotationPhase,
    patch: VaultRotationPatch,
  ): VaultRotationRow {
    const current = this.getRotation(citadelId, rotationId);
    if (!current || current.phase !== fromPhase) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "The rotation moved on. Reload it before continuing.",
        details: { reason: "VAULT_ROTATION_PHASE_CHANGED" },
      });
    }
    const phase = patch.phase ?? current.phase;
    const terminal = CITADEL_VAULT_TERMINAL_ROTATION_PHASES.includes(phase);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE citadel_vault_rotations SET phase = @phase, open_citadel_id = @open, approval_id = @approvalId,
        resealed_count = @resealedCount, total_count = @totalCount, last_error_code = @lastErrorCode,
        from_kek_version = @fromKekVersion, to_kek_version = @toKekVersion, updated_at = @now, completed_at = @completedAt
      WHERE rotation_id = @rotationId AND phase = @fromPhase`,
      )
      .run({
        rotationId,
        fromPhase,
        phase,
        open: terminal ? null : citadelId,
        approvalId: patch.approvalId ?? current.approvalId ?? null,
        resealedCount: patch.resealedCount ?? current.resealedCount,
        totalCount: patch.totalCount ?? current.totalCount,
        lastErrorCode: patch.lastErrorCode === undefined ? (current.lastErrorCode ?? null) : patch.lastErrorCode,
        fromKekVersion: patch.fromKekVersion ?? current.fromKekVersion ?? null,
        toKekVersion: patch.toKekVersion ?? current.toKekVersion ?? null,
        now,
        completedAt: terminal ? now : null,
      });
    if (phase === "completed") advanceCitadelVaultGeneration(this.db, citadelId);
    return this.getRotation(citadelId, rotationId)!;
  }
}

function mapKey(row: KeyRowDb): VaultKeyRow {
  return {
    keyId: row.key_id,
    citadelId: row.citadel_id,
    chamberId: row.chamber_id,
    dekVersion: Number(row.dek_version),
    kekVersion: Number(row.kek_version),
    wrappedDek: safeJsonParse<SealedValue>(row.wrapped_dek_json, { iv: "", ciphertext: "", tag: "" }),
    active: row.active_scope_key !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRotation(row: RotationRowDb): VaultRotationRow {
  const optionalNumber = (value: number | string | null) => (value === null ? undefined : Number(value));
  return {
    rotationId: row.rotation_id,
    citadelId: row.citadel_id,
    target: row.target === "kek" ? "kek" : "dek",
    chamberId: row.chamber_id,
    phase: ROTATION_PHASES.has(row.phase as CitadelVaultRotationPhase)
      ? (row.phase as CitadelVaultRotationPhase)
      : "failed",
    approvalId: row.approval_id ?? undefined,
    resealedCount: Number(row.resealed_count),
    totalCount: Number(row.total_count),
    lastErrorCode: row.last_error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    fromKeyId: row.from_key_id ?? undefined,
    toKeyId: row.to_key_id ?? undefined,
    fromKekVersion: optionalNumber(row.from_kek_version),
    toKekVersion: optionalNumber(row.to_kek_version),
    requestedBy: row.requested_by,
    reason: row.reason,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError({ message: `Invalid ${label}.` });
}
