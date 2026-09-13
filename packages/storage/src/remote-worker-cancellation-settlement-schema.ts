import type { DatabaseSync } from "node:sqlite";

const SQLITE_GUARD = "trg_remote_worker_assignment_settlements_live_authority";
const LIVE_FUNCTION = "gc_remote_worker_assignment_has_live_authority";
const SETTLEMENT_FUNCTION = "gc_remote_worker_assignment_has_settlement_authority";

function heartbeatFences(dialect: "sqlite" | "postgres") {
  const field = (name: string) =>
    dialect === "sqlite"
      ? `json_extract(lease.parent_dispatch_authority_json, '$.${name}')`
      : `lease.parent_dispatch_authority_json::jsonb ->> '${name}'`;
  const version = dialect === "sqlite" ? field("durableRunVersion") : `(${field("durableRunVersion")})::BIGINT`;
  const attempt = dialect === "sqlite" ? field("durableRunAttempt") : `(${field("durableRunAttempt")})::BIGINT`;
  const cancelled = dialect === "sqlite" ? "NEW.outcome = 'cancelled'" : "allow_cancelled_heartbeat";
  return [
    [`run.version = ${version}`, `(run.version = ${version} OR (${cancelled} AND run.version >= ${version}))`],
    [
      `run.lease_expires_at = ${field("durableRunLeaseExpiresAt")}`,
      `(run.lease_expires_at = ${field("durableRunLeaseExpiresAt")} OR (${cancelled}
        AND run.lease_expires_at >= ${field("durableRunLeaseExpiresAt")}))`,
    ],
    [
      "run.status = 'running'",
      `run.status = 'running'
      AND (NOT (${cancelled}) OR (
        run.lease_owner_id = ${field("dispatchOwnerId")}
        AND run.attempt_count = ${attempt}
        AND EXISTS (SELECT 1 FROM remote_worker_assignment_controls control
          WHERE control.registry_workspace_id = generation.registry_workspace_id
            AND control.assignment_id = generation.assignment_id
            AND control.assignment_generation = generation.assignment_generation
            AND control.action = 'cancel_requested')
      ))`,
    ],
  ] as const;
}

/** Forward-only guard repair. It creates no execution authority or new rows.
 * Rollback requires a new migration restoring exact settlement heartbeat fences;
 * historical cancellation receipts remain immutable. */
export function upgradeRemoteWorkerCancellationSettlement(db: Pick<DatabaseSync, "prepare" | "exec">): void {
  let sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(SQLITE_GUARD)?.sql;
  if (typeof sql !== "string") throw new Error("Worker cancellation settlement requires the current authority guard");
  for (const [needle, replacement] of heartbeatFences("sqlite")) {
    if (sql.split(needle).length !== 2)
      throw new Error("Worker cancellation settlement found an unexpected authority guard");
    sql = sql.replace(needle, replacement);
  }
  db.exec(`DROP TRIGGER ${SQLITE_GUARD}`);
  db.exec(sql);
}

// Clone the current canonical guard so event and execution authority retain
// exact heartbeat fences. Only the settlement trigger can select cancellation.
export const REMOTE_WORKER_CANCELLATION_SETTLEMENT_POSTGRES_SQL = `
DO $cancel_settlement$
DECLARE guard_oid REGPROCEDURE; definition TEXT; needle TEXT; replacement TEXT;
BEGIN
  guard_oid := to_regprocedure('${LIVE_FUNCTION}(text,text,bigint)');
  IF guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = guard_oid AND n.nspname = current_schema()
  ) THEN RAISE EXCEPTION 'Worker cancellation settlement requires the current authority guard'; END IF;
  definition := pg_get_functiondef(guard_oid);
  needle := '${LIVE_FUNCTION}(';
  IF cardinality(string_to_array(definition, needle)) <> 2 THEN
    RAISE EXCEPTION 'Worker cancellation settlement found an unexpected authority signature';
  END IF;
  definition := replace(definition, needle, '${SETTLEMENT_FUNCTION}(allow_cancelled_heartbeat boolean, ');
  ${heartbeatFences("postgres")
    .map(
      ([needle, replacement]) => `
  needle := $needle$${needle}$needle$;
  replacement := $replacement$${replacement}$replacement$;
  IF cardinality(string_to_array(definition, needle)) <> 2 THEN
    RAISE EXCEPTION 'Worker cancellation settlement found an unexpected authority fence';
  END IF;
  definition := replace(definition, needle, replacement);`,
    )
    .join("\n")}
  EXECUTE definition;
  guard_oid := to_regprocedure('gc_remote_worker_assignment_settlement_guard()');
  IF guard_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = guard_oid AND n.nspname = current_schema()
  ) THEN RAISE EXCEPTION 'Worker cancellation settlement requires the current settlement guard'; END IF;
  definition := pg_get_functiondef(guard_oid);
  needle := '${LIVE_FUNCTION}(';
  IF cardinality(string_to_array(definition, needle)) <> 2 THEN
    RAISE EXCEPTION 'Worker cancellation settlement found an unexpected settlement authority call';
  END IF;
  EXECUTE replace(definition, needle, '${SETTLEMENT_FUNCTION}(NEW.outcome = ''cancelled'', ');
END $cancel_settlement$;
`;
