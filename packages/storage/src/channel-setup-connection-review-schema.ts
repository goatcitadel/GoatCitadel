import type { DatabaseClient } from "./db.js";

export const CHANNEL_SETUP_CONNECTION_REVIEW_POSTGRES_SQL = `
ALTER TABLE channel_setup_drafts ADD COLUMN IF NOT EXISTS connection_revision TEXT;
`;

/** Existing drafts remain unreviewed until the operator explicitly reviews their connection. */
export function createChannelSetupConnectionReviewSchema(db: Pick<DatabaseClient, "exec">): void {
  db.exec("ALTER TABLE channel_setup_drafts ADD COLUMN connection_revision TEXT;");
}
