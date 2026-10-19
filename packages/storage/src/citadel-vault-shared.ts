import { ValidationError, type SealedValueV2 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

/** Advances the persisted Vault review generation; callers hold the Citadel lock. */
export function advanceCitadelVaultGeneration(db: Pick<DatabaseClient, "prepare">, citadelId: string): void {
  db.prepare(
    `INSERT INTO citadel_vault_revisions (citadel_id, generation) VALUES (@citadelId, 1)
    ON CONFLICT (citadel_id) DO UPDATE SET generation = citadel_vault_revisions.generation + 1`,
  ).run({ citadelId });
}

/** Bound (v2) envelopes name the data key that sealed them; anything else is refused. */
export function assertBoundEnvelope(value: SealedValueV2 | undefined): asserts value is SealedValueV2 {
  if (
    value?.v !== 2 ||
    typeof value.keyId !== "string" ||
    value.keyId.length === 0 ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string"
  ) {
    throw new ValidationError({ message: "Vault writes require a bound (v2) envelope." });
  }
}

export const vaultScopeKey = (chamberId: string | null): string => chamberId ?? "";
