import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSqliteSchemaBlueprint } from "./sqlite.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

describe("channel and cron durability schema parity", () => {
  it("keeps the live SQLite blueprint and generated Postgres schema aligned", () => {
    const blueprint = createSqliteSchemaBlueprint();
    const inbound = blueprint.tables.find((table) => table.name === "inbound_channel_events");
    const cronRuns = blueprint.tables.find((table) => table.name === "cron_runs");
    const cronJobs = blueprint.tables.find((table) => table.name === "cron_jobs");
    assert.ok(inbound);
    assert.ok(cronRuns);
    assert.ok(cronJobs?.columns.some((column) => column.name === "execution_generation"));
    assert.ok(cronJobs?.columns.some((column) => column.name === "active_run_id"));
    assert.ok(inbound?.columns.some((column) => column.name === "bot_loop_decision"));
    assert.ok(inbound?.columns.some((column) => column.name === "bot_loop_reason"));
    assert.ok(inbound?.columns.some((column) => column.name === "command_operation_key"));
    assert.ok(inbound?.columns.some((column) => column.name === "command_result_text"));
    assert.equal(inbound?.indexes.find((index) => index.name === "idx_inbound_channel_events_identity")?.unique, true);
    assert.equal(cronRuns?.indexes.find((index) => index.name === "idx_cron_runs_admission")?.unique, true);
    assert.equal(cronRuns?.foreignKeys.length, 0, "cron history must survive job deletion/recreation");
    assert.equal(
      cronRuns?.indexes.find((index) => index.name === "idx_cron_runs_child_durable")?.where,
      "child_durable_run_id IS NOT NULL",
    );

    const postgresRuntimeSql = buildPostgresRuntimeSchemaSql();
    assert.match(postgresRuntimeSql, /CREATE TABLE IF NOT EXISTS inbound_channel_events \(/);
    assert.match(postgresRuntimeSql, /sequence BIGSERIAL PRIMARY KEY/);
    assert.match(postgresRuntimeSql, /CREATE TABLE IF NOT EXISTS cron_runs \(/);
    assert.match(postgresRuntimeSql, /idx_inbound_channel_events_identity/);
    assert.match(postgresRuntimeSql, /bot_loop_decision TEXT/);
    assert.match(postgresRuntimeSql, /idx_cron_runs_job_generation/);
    assert.match(postgresRuntimeSql, /idx_cron_runs_pending_settlement/);
  });

  it("provides immutable forward Postgres migration 91 for existing runtimes", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 91);
    assert.equal(migration?.name, "channel_acceptance_and_cron_run_durability");
    assert.match(migration?.sql ?? "", /ALTER TABLE cron_jobs/);
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS execution_generation BIGINT NOT NULL DEFAULT 0/);
    assert.match(migration?.sql ?? "", /CREATE TABLE IF NOT EXISTS inbound_channel_events/);
    assert.match(migration?.sql ?? "", /CREATE TABLE IF NOT EXISTS cron_runs/);
    assert.match(migration?.sql ?? "", /idx_inbound_channel_events_identity/);
    assert.match(migration?.sql ?? "", /idx_cron_runs_admission/);
    assert.match(migration?.sql ?? "", /idx_cron_runs_child_durable/);
    assert.doesNotMatch(migration?.sql ?? "", /job_id TEXT NOT NULL REFERENCES cron_jobs/);
  });

  it("provides immutable forward Postgres migration 92 for durable inbound admission settlement", () => {
    const migration = POSTGRES_MIGRATIONS.find((candidate) => candidate.version === 92);
    assert.equal(migration?.name, "inbound_channel_admission_settlement");
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS bot_loop_decision TEXT/);
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS bot_loop_reason TEXT/);
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS command_operation_key TEXT/);
    assert.match(migration?.sql ?? "", /ADD COLUMN IF NOT EXISTS command_result_text TEXT/);
  });
});
