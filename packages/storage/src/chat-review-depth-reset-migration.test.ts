import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatSessionPrefsRepository } from "./chat-session-prefs-repo.js";
import {
  RESET_CHAT_REVIEW_DEPTH_POSTGRES_SQL,
  RESET_CHAT_REVIEW_DEPTH_SQLITE_SQL,
} from "./chat-review-depth-reset-migration.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { __sqliteInternals } from "./sqlite.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const SQLITE_VERSION = 275;
const POSTGRES_VERSION = 224;
const MIGRATION_NAME = "reset_chat_review_depth";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function readDepths(dbPath: string): Record<string, string> {
  const raw = new DatabaseSync(dbPath);
  try {
    const rows = raw
      .prepare("SELECT session_id, orchestration_review_depth FROM chat_session_prefs ORDER BY session_id")
      .all() as Array<{ session_id: string; orchestration_review_depth: string }>;
    return Object.fromEntries(rows.map((row) => [row.session_id, row.orchestration_review_depth]));
  } finally {
    raw.close();
  }
}

describe("chat review depth reset migration", () => {
  it("is registered under the shared name in both lineages with the same SQL", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(SQLITE_VERSION), MIGRATION_NAME);
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === POSTGRES_VERSION);
    assert.equal(postgres?.name, MIGRATION_NAME);
    assert.equal(postgres?.sql, RESET_CHAT_REVIEW_DEPTH_POSTGRES_SQL);
    assert.equal(RESET_CHAT_REVIEW_DEPTH_POSTGRES_SQL, RESET_CHAT_REVIEW_DEPTH_SQLITE_SQL);
  });

  it("resets every stored standard and strict value to off and leaves other prefs alone", () => {
    const dbPath = tempDbs.path("goatcitadel-chat-review-depth-reset");
    const db = tempDbs.open({ dbPath });
    const meta = new ChatSessionMetaRepository(db);
    for (const sessionId of ["session-standard", "session-strict", "session-off"]) {
      meta.ensure(sessionId, undefined, "default");
    }
    const prefs = new ChatSessionPrefsRepository(db);
    prefs.patch("session-standard", { orchestrationReviewDepth: "standard", webMode: "deep" });
    prefs.patch("session-strict", { orchestrationReviewDepth: "strict" });
    prefs.patch("session-off", { orchestrationReviewDepth: "off" });
    db.close();
    assert.deepEqual(readDepths(dbPath), {
      "session-off": "off",
      "session-standard": "standard",
      "session-strict": "strict",
    });

    const raw = new DatabaseSync(dbPath);
    try {
      __sqliteInternals.applySchemaMigrationForTest(SQLITE_VERSION, raw);
    } finally {
      raw.close();
    }

    assert.deepEqual(readDepths(dbPath), {
      "session-off": "off",
      "session-standard": "off",
      "session-strict": "off",
    });
    const reopened = tempDbs.open({ dbPath });
    assert.equal(new ChatSessionPrefsRepository(reopened).get("session-standard")?.webMode, "deep");
    reopened.close();
  });

  it("defaults new sessions to off, and an explicit choice persists after the migration", () => {
    const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-chat-review-depth-default") });
    new ChatSessionMetaRepository(db).ensure("session-new", undefined, "default");
    const prefs = new ChatSessionPrefsRepository(db);
    assert.equal(prefs.ensure("session-new").orchestrationReviewDepth, "off");
    assert.equal(
      prefs.patch("session-new", { orchestrationReviewDepth: "standard" }).orchestrationReviewDepth,
      "standard",
    );
    assert.equal(prefs.get("session-new")?.orchestrationReviewDepth, "standard");
    db.close();
  });
});
