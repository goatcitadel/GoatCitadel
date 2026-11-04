/**
 * Runs are still created lazily by their repository, so this additive table has
 * no foreign key. Prompt-pack deletion removes its claims before its runs.
 * A null token retains the lock slot after cancellation or terminal settlement.
 */
export const MODEL_COMPARISON_CLAIM_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS model_comparison_execution_claims (
    comparison_id TEXT NOT NULL PRIMARY KEY,
    claim_id TEXT
  );
`;
