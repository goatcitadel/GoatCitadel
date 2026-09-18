import { createHash, randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError, type CitadelRecord, type CitadelVaultMutation,
  type CitadelVaultSecretInput, type CitadelVaultSecretMetadata, type CitadelVaultSecretRecord,
  type CitadelVaultSnapshot, type SealedValue } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface VaultSecretRow {
  secret_id: string;
  citadel_id: string;
  secret_name: string;
  sealed_value_json: string;
  created_at: string;
  updated_at: string;
}

interface CitadelVaultContext {
  withLock<T>(citadelId: string, action: () => T): T;
  readRecord(citadelId: string): CitadelRecord | undefined;
}

/** Shares the Citadel lifecycle lock; plaintext never enters this repository. */
export class CitadelVaultRepository {
  private readonly storeStmt;
  private readonly getStmt;
  private readonly getByNameStmt;
  private readonly listStmt;
  private readonly metadataStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient, private readonly context: CitadelVaultContext) {
    this.storeStmt = db.prepare(`
      INSERT INTO citadel_vault_secrets (secret_id, citadel_id, secret_name, sealed_value_json, created_at, updated_at)
      VALUES (@secretId, @citadelId, @secretName, @sealedValueJson, @now, @now)
      ON CONFLICT(citadel_id, secret_name) DO UPDATE SET
        sealed_value_json = excluded.sealed_value_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare("SELECT * FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId");
    this.getByNameStmt = db.prepare("SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId AND secret_name = @secretName");
    this.listStmt = db.prepare("SELECT * FROM citadel_vault_secrets WHERE citadel_id = @citadelId ORDER BY secret_name ASC, secret_id ASC");
    this.metadataStmt = db.prepare("SELECT secret_id, secret_name, created_at, updated_at FROM citadel_vault_secrets WHERE citadel_id = @citadelId ORDER BY secret_name ASC, secret_id ASC");
    this.deleteStmt = db.prepare("DELETE FROM citadel_vault_secrets WHERE secret_id = @secretId AND citadel_id = @citadelId");
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
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "The Vault changed. Review its current names and update times before applying your change.",
          details: { reason: "CITADEL_VAULT_REVISION_CONFLICT" } });
      }
      if (current.record?.lifecycleStatus === "archived") {
        throw new ConflictError({ code: "WRITE_CONFLICT", message: "Restore this Citadel before changing its Vault.", details: { reason: "CITADEL_ARCHIVED" } });
      }
      if (input.change.type === "store") {
        this.store({ citadelId: input.citadelId, secretName: input.change.secretName, sealedValue: input.change.sealedValue });
      } else if (input.change.type === "delete") {
        if (!this.delete(input.citadelId, input.change.secretId)) throw new NotFoundError({ entity: "Vault secret" });
      } else throw new ValidationError({ message: "Unsupported Vault change." });
      return this.readSnapshot(input.citadelId);
    });
  }

  public store(input: CitadelVaultSecretInput): CitadelVaultSecretRecord {
    return this.context.withLock(input.citadelId, () => {
      const previous = this.getByNameStmt.get<VaultSecretRow>({ citadelId: input.citadelId, secretName: input.secretName });
      const last = Date.parse(previous?.updated_at ?? "");
      const now = new Date(Math.max(Date.now(), Number.isFinite(last) ? last + 1 : 0)).toISOString();
      this.storeStmt.run({ secretId: randomUUID(), citadelId: input.citadelId, secretName: input.secretName,
        sealedValueJson: JSON.stringify(input.sealedValue), now });
      this.advance(input.citadelId);
      const row = this.getByNameStmt.get<VaultSecretRow>({ citadelId: input.citadelId, secretName: input.secretName });
      if (!row) throw new Error("Failed to persist the sealed Vault secret.");
      return mapSecret(row);
    });
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
      if (removed) this.advance(citadelId);
      return removed;
    });
  }

  private readSnapshot(citadelId: string): CitadelVaultSnapshot {
    const record = this.context.readRecord(citadelId);
    const generation = this.db.prepare("SELECT CAST(generation AS TEXT) AS generation FROM citadel_vault_revisions WHERE citadel_id = @citadelId")
      .get<{ generation: string }>({ citadelId })?.generation ?? "0";
    const items: CitadelVaultSecretMetadata[] = this.metadataStmt.all<VaultSecretRow>({ citadelId }).map((row) => ({
      secretId: row.secret_id, secretName: row.secret_name, createdAt: row.created_at, updatedAt: row.updated_at,
    }));
    const revision = createHash("sha256").update(JSON.stringify({ schemaVersion: "citadel.vault.v1", citadelId, generation, recordRevision: record?.revision ?? null, items })).digest("hex");
    return { citadelId, revision, record, items };
  }

  private advance(citadelId: string): void {
    this.db.prepare(`INSERT INTO citadel_vault_revisions (citadel_id, generation) VALUES (@citadelId, 1)
      ON CONFLICT (citadel_id) DO UPDATE SET generation = citadel_vault_revisions.generation + 1`).run({ citadelId });
  }
}

function mapSecret(row: VaultSecretRow): CitadelVaultSecretRecord {
  return { secretId: row.secret_id, citadelId: row.citadel_id, secretName: row.secret_name,
    sealedValue: safeJsonParse<SealedValue>(row.sealed_value_json, { iv: "", ciphertext: "", tag: "" }),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
