import { Client } from "pg";

// The two-int advisory namespace does not overlap PostgreSQL's single-bigint
// namespace, which keeps this test lease separate from production migration
// advisory keys.
const GATEWAY_LIVE_POSTGRES_TEST_LOCK_NAMESPACE = 0x4743_4c54;
const GATEWAY_LIVE_POSTGRES_TEST_LOCK_KEY = 1;
const GATEWAY_LIVE_POSTGRES_TEST_STATEMENT_TIMEOUT_MS = 110_000;

export interface GatewayLivePostgresTestLease {
  release(): Promise<void>;
}

/**
 * Serializes the Gateway's live-PostgreSQL integration suites without changing
 * production migration behavior. Those suites intentionally hold transactions
 * longer than the migration quiescence timeout, so they cannot safely migrate
 * separate schemas concurrently inside the same physical test database.
 *
 * A session advisory lock is process-safe and PostgreSQL releases it if a test
 * worker exits before cleanup.
 */
export async function acquireGatewayLivePostgresTestLease(
  connectionString: string,
): Promise<GatewayLivePostgresTestLease> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 115_000,
    // Keep the server-side cancellation inside the 120-second Vitest hook
    // timeout so a wedged lease owner cannot leave the worker waiting forever.
    statement_timeout: GATEWAY_LIVE_POSTGRES_TEST_STATEMENT_TIMEOUT_MS,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("SELECT pg_catalog.pg_advisory_lock($1::integer, $2::integer)", [
      GATEWAY_LIVE_POSTGRES_TEST_LOCK_NAMESPACE,
      GATEWAY_LIVE_POSTGRES_TEST_LOCK_KEY,
    ]);
  } catch (error) {
    if (connected) {
      await client.end().catch(() => undefined);
    }
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;

      let releaseFailure: unknown;
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
          [GATEWAY_LIVE_POSTGRES_TEST_LOCK_NAMESPACE, GATEWAY_LIVE_POSTGRES_TEST_LOCK_KEY],
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error("Gateway live-PostgreSQL test lease was not held by its pinned session.");
        }
      } catch (error) {
        releaseFailure = error;
      }

      try {
        await client.end();
      } catch (error) {
        releaseFailure ??= error;
      }

      if (releaseFailure !== undefined) {
        throw releaseFailure;
      }
    },
  };
}
