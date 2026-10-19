import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  VAULT_ERROR_CODES,
  type CitadelRecord,
  type CitadelVaultMutation,
  type CitadelVaultRotationView,
  type CitadelVaultScopeKeyMetadata,
  type CitadelVaultSecretInput,
  type CitadelVaultSecretMetadata,
  type CitadelVaultSecretRecord,
  type CitadelVaultSnapshot,
  type CitadelVaultStoredKeyMetadata,
  type SealedValue,
  type SealedValueV2,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { CitadelVaultKeyRepository } from "./citadel-vault-key-repo.js";
import { advanceCitadelVaultGeneration, assertBoundEnvelope } from "./citadel-vault-shared.js";
import { safeJsonParse } from "./safe-json.js";

export { advanceCitadelVaultGeneration } from "./citadel-vault-shared.js";

interface VaultSecretRow {
  secret_id: string;
  citadel_id: string;
  secret_name: string;
  chamber_id: string | null;
  key_id: string | null;
  envelope_version: number | string;
  sealed_value_json: string;
  created_at: string;
  updated_at: string;
}

interface VaultMetadataRow {
  secret_id: string;
  secret_name: string;
  chamber_id: string | null;
  created_at: string;
  updated_at: string;
  dek_version: number | string | null;
}

interface CitadelVaultContext {
  withLock<T>(citadelId: string, action: () => T): T;
  readRecord(citadelId: string): CitadelRecord | undefined;
  listChambers(citadelId: string): Array<{ chamberId: string; name: string }>;
  keys(): CitadelVaultKeyRepository;
}

interface StoreRow {
  secretId: string;
  citadelId: string;
  secretName: string;
  chamberId: string | null;
  keyId: string | null;
  envelopeVersion: 1 | 2;
  sealedValue: SealedValue;
}

/** Shares the Citadel lifecycle lock; plaintext never enters this repository. */
export class CitadelVaultRepository {
  private readonly storeStmt;
  private readonly getStmt;
  private readonly getByNameStmt;
  private readonly listStmt;
  private readonly metadataStmt;
  private readonly deleteStmt;

  public constructor(
    private readonly db: DatabaseClient,
    private readonly context: CitadelVaultContext,
  ) {
    this.storeStmt = db.prepare(`
      INSERT INTO citadel_vault_secrets (secret_id, citadel_id, secret_name, chamber_id, key_id, envelope_version,
        sealed_value_json, created_at, updated_at)
      VALUES (@secretId, @citadelId, @secretName, @chamberId, @keyId, @envelopeVersion, @sealedValueJson, @now, @now)
      ON CONFLICT(citadel_id, secret_name) DO UPDATE SET
        chamber_id = excluded.chamber_id,
        key_id = excluded.key_id,
        envelope_version = excluded.envelope_version,
        sealed_value_json = excluded.sealed_value_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId",
    );
    this.getByNameStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND secret_name = @secretName",
    );
    this.listStmt = db.prepare(
      "SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId ORDER BY secret_name ASC, secret_id ASC",
    );
    this.metadataStmt =
      db.prepare(`SELECT s.secret_id, s.secret_name, s.chamber_id, s.created_at, s.updated_at, k.dek_version
      FROM citadel_vault_secrets s LEFT JOIN citadel_vault_keys k ON k.key_id = s.key_id AND k.citadel_id = s.citadel_id
      WHERE s.citadel_id = @citadelId ORDER BY s.secret_name ASC, s.secret_id ASC`);
    this.deleteStmt = db.prepare(
      "DELETE FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId",
    );
  }

  public getSnapshot(citadelId: string): CitadelVaultSnapshot {
    return this.context.withLock(citadelId, () => this.readSnapshot(citadelId));
  }

  public mutate(input: CitadelVaultMutation): CitadelVaultSnapshot {
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "")) {
      throw new ValidationError({ message: "Review the Vault before changing it. An expected revision is required." });
    }
    return this.context.withLock(input.citadelId, () => {
      const current = this.readSnapshot(input.citadelId);
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict();
      }
      if (current.record?.lifecycleStatus === "archived") {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Restore this Citadel before changing its Vault.",
          details: { reason: "CITADEL_ARCHIVED" },
        });
      }
      const change = input.change;
      if (change.type === "store") {
        this.store({ citadelId: input.citadelId, secretName: change.secretName, sealedValue: change.sealedValue });
      } else if (change.type === "store_bound") {
        this.storeBound(input.citadelId, change);
      } else if (change.type === "move") {
        this.move(input.citadelId, change);
      } else if (change.type === "delete") {
        if (!this.delete(input.citadelId, change.secretId)) throw new NotFoundError({ entity: "Vault secret" });
      } else throw new ValidationError({ message: "Unsupported Vault change." });
      return this.readSnapshot(input.citadelId);
    });
  }

  /** Legacy v1 store, sealed directly under the Citadel key. */
  public store(input: CitadelVaultSecretInput): CitadelVaultSecretRecord {
    return this.context.withLock(input.citadelId, () =>
      this.write({
        secretId: randomUUID(),
        citadelId: input.citadelId,
        secretName: input.secretName,
        chamberId: null,
        keyId: null,
        envelopeVersion: 1,
        sealedValue: input.sealedValue,
      }),
    );
  }

  public get(citadelId: string, secretId: string): CitadelVaultSecretRecord | undefined {
    const row = this.getStmt.get<VaultSecretRow>({ citadelId, secretId });
    return row ? mapSecret(row) : undefined;
  }

  public list(citadelId: string): CitadelVaultSecretRecord[] {
    return this.listStmt.all<VaultSecretRow>({ citadelId }).map(mapSecret);
  }

  public delete(citadelId: string, secretId: string): boolean {
    return this.context.withLock(citadelId, () => {
      const removed = Number(this.deleteStmt.run({ citadelId, secretId }).changes) > 0;
      if (removed) advanceCitadelVaultGeneration(this.db, citadelId);
      return removed;
    });
  }

  private storeBound(
    citadelId: string,
    change: { secretId: string; secretName: string; chamberId: string | null; sealedValue: SealedValueV2 },
  ): void {
    assertBoundEnvelope(change.sealedValue);
    this.assertChamber(citadelId, change.chamberId);
    const byName = this.getByNameStmt.get<VaultSecretRow>({ citadelId, secretName: change.secretName });
    const byId = this.getStmt.get<VaultSecretRow>({ citadelId, secretId: change.secretId });
    // The Gateway sealed against the reviewed name→ID mapping; the matching revision proves it,
    // and this check refuses any command that names a different ID.
    if (byName ? byName.secret_id !== change.secretId : byId !== undefined) throw revisionConflict();
    this.assertActiveKey(citadelId, change.chamberId, change.sealedValue.keyId);
    this.write({
      secretId: change.secretId,
      citadelId,
      secretName: change.secretName,
      chamberId: change.chamberId,
      keyId: change.sealedValue.keyId,
      envelopeVersion: 2,
      sealedValue: change.sealedValue,
    });
  }

  private move(
    citadelId: string,
    change: { secretId: string; chamberId: string | null; sealedValue: SealedValueV2 },
  ): void {
    assertBoundEnvelope(change.sealedValue);
    const existing = this.getStmt.get<VaultSecretRow>({ citadelId, secretId: change.secretId });
    if (!existing) throw new NotFoundError({ entity: "Vault secret" });
    this.assertChamber(citadelId, change.chamberId);
    this.assertActiveKey(citadelId, change.chamberId, change.sealedValue.keyId);
    this.db
      .prepare(
        `UPDATE citadel_vault_secrets SET chamber_id = @chamberId, key_id = @keyId, envelope_version = 2,
        sealed_value_json = @sealed WHERE citadel_id = @citadelId AND secret_id = @secretId`,
      )
      .run({
        citadelId,
        secretId: change.secretId,
        chamberId: change.chamberId,
        keyId: change.sealedValue.keyId,
        sealed: JSON.stringify(change.sealedValue),
      });
    advanceCitadelVaultGeneration(this.db, citadelId);
  }

  private write(row: StoreRow): CitadelVaultSecretRecord {
    const previous = this.getByNameStmt.get<VaultSecretRow>({ citadelId: row.citadelId, secretName: row.secretName });
    const last = Date.parse(previous?.updated_at ?? "");
    const now = new Date(Math.max(Date.now(), Number.isFinite(last) ? last + 1 : 0)).toISOString();
    this.storeStmt.run({
      secretId: row.secretId,
      citadelId: row.citadelId,
      secretName: row.secretName,
      chamberId: row.chamberId,
      keyId: row.keyId,
      envelopeVersion: row.envelopeVersion,
      sealedValueJson: JSON.stringify(row.sealedValue),
      now,
    });
    advanceCitadelVaultGeneration(this.db, row.citadelId);
    const stored = this.getByNameStmt.get<VaultSecretRow>({ citadelId: row.citadelId, secretName: row.secretName });
    if (!stored) throw new Error("Failed to persist the sealed Vault secret.");
    return mapSecret(stored);
  }

  private assertChamber(citadelId: string, chamberId: string | null): void {
    if (
      chamberId !== null &&
      !this.context.listChambers(citadelId).some((chamber) => chamber.chamberId === chamberId)
    ) {
      throw new NotFoundError({ entity: "Chamber" });
    }
  }

  /** A store or move must name the scope's current active data key, never a retiring one. */
  private assertActiveKey(citadelId: string, chamberId: string | null, keyId: string): void {
    if (this.context.keys().getActiveKey(citadelId, chamberId)?.keyId !== keyId) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "The Vault key for this scope changed. Seal the value again.",
        details: { reason: VAULT_ERROR_CODES.keyChanged },
      });
    }
  }

  private readSnapshot(citadelId: string): CitadelVaultSnapshot {
    const record = this.context.readRecord(citadelId);
    const generation =
      this.db
        .prepare(
          "SELECT CAST(generation AS TEXT) AS generation FROM citadel_vault_revisions WHERE citadel_id = @citadelId",
        )
        .get<{ generation: string }>({ citadelId })?.generation ?? "0";
    const items: CitadelVaultSecretMetadata[] = this.metadataStmt.all<VaultMetadataRow>({ citadelId }).map((row) => ({
      secretId: row.secret_id,
      secretName: row.secret_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      chamberId: row.chamber_id,
      keyVersion: row.dek_version === null ? null : Number(row.dek_version),
    }));
    const keys = this.readKeyMetadata(citadelId, items);
    // The digest covers names, IDs, times, scope, the KEK version and an open rotation's phase.
    // Key versions, counts and the background legacy upgrade are left out so they never 409 an operator.
    const digestItems = items.map(({ keyVersion: _keyVersion, ...rest }) => rest);
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          schemaVersion: "citadel.vault.v2",
          citadelId,
          generation,
          recordRevision: record?.revision ?? null,
          items: digestItems,
          kekVersion: keys.kekVersion,
          rotation: keys.rotation ? { rotationId: keys.rotation.rotationId, phase: keys.rotation.phase } : null,
        }),
      )
      .digest("hex");
    return { citadelId, revision, record, items, keys };
  }

  private readKeyMetadata(citadelId: string, items: CitadelVaultSecretMetadata[]): CitadelVaultStoredKeyMetadata {
    const keyRepo = this.context.keys();
    const state = keyRepo.getKeyState(citadelId);
    const activeKeys = keyRepo.listKeys(citadelId).filter((key) => key.active);
    const chambers = this.context.listChambers(citadelId);
    const scopeIds: Array<string | null> = [null, ...chambers.map((chamber) => chamber.chamberId)];
    for (const item of items) if (!scopeIds.includes(item.chamberId)) scopeIds.push(item.chamberId);
    const scopes: CitadelVaultScopeKeyMetadata[] = scopeIds.map((chamberId) => {
      const active = activeKeys.find((key) => key.chamberId === chamberId);
      const chamberName = chambers.find((chamber) => chamber.chamberId === chamberId)?.name;
      return {
        chamberId,
        ...(chamberName ? { chamberName } : {}),
        activeKeyVersion: active?.dekVersion ?? null,
        ...(active ? { keyCreatedAt: active.createdAt } : {}),
        secretCount: items.filter((item) => item.chamberId === chamberId).length,
      };
    });
    const open = keyRepo.getOpenRotation(citadelId);
    const rotation: CitadelVaultRotationView | undefined = open
      ? {
          rotationId: open.rotationId,
          target: open.target,
          chamberId: open.chamberId,
          phase: open.phase,
          ...(open.approvalId ? { approvalId: open.approvalId } : {}),
          resealedCount: open.resealedCount,
          totalCount: open.totalCount,
          ...(open.lastErrorCode ? { lastErrorCode: open.lastErrorCode } : {}),
          createdAt: open.createdAt,
          updatedAt: open.updatedAt,
        }
      : undefined;
    return {
      kekVersion: state?.kekVersion ?? null,
      ...(state?.kekRotatedAt ? { kekRotatedAt: state.kekRotatedAt } : {}),
      scopes,
      legacySecretCount: keyRepo.countLegacy(citadelId),
      ...(rotation ? { rotation } : {}),
    };
  }
}

function revisionConflict(): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The Vault changed. Review its current names and update times before applying your change.",
    details: { reason: "CITADEL_VAULT_REVISION_CONFLICT" },
  });
}

function mapSecret(row: VaultSecretRow): CitadelVaultSecretRecord {
  return {
    secretId: row.secret_id,
    citadelId: row.citadel_id,
    secretName: row.secret_name,
    chamberId: row.chamber_id ?? null,
    keyId: row.key_id ?? null,
    envelopeVersion: Number(row.envelope_version) === 2 ? 2 : 1,
    sealedValue: safeJsonParse<SealedValue>(row.sealed_value_json, { iv: "", ciphertext: "", tag: "" }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
