import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Snapshot only the freshly owned, stopped native runtime. Read-only SQLite
 * preserves the native session/tool records; it does not infer approval votes. */
export async function readHermesNativeTranscript({ stateDirectory }) {
  if (!path.isAbsolute(stateDirectory ?? "")) throw new Error("The Hermes state directory must be absolute.");
  const filename = path.join(stateDirectory, "state.db");
  let stat;
  try {
    stat = await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT")
      return { source: "native_session_database", status: "missing", sessions: [], messages: [] };
    throw error;
  }
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 64 * 1024 * 1024 ||
    normalize(await realpath(filename)) !== normalize(path.resolve(filename))
  )
    throw new Error("The native Hermes transcript database must be an ordinary bounded file.");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
    const counts = db
      .prepare(
        `SELECT
      (SELECT count(*) FROM sessions) AS sessions,
      (SELECT count(*) FROM messages) AS messages,
      (SELECT coalesce(sum(length(coalesce(content,'')) + length(coalesce(tool_calls,''))),0) FROM messages) AS characters`,
      )
      .get();
    if (counts.sessions > 128 || counts.messages > 2000 || counts.characters > 1024 * 1024)
      throw new Error("The native Hermes transcript exceeds the comparison bound.");
    const sessions = db
      .prepare(
        `SELECT id,source,model,parent_session_id,started_at,ended_at,end_reason,
      message_count,tool_call_count,cwd,billing_provider,tool_names FROM sessions ORDER BY started_at,id`,
      )
      .all();
    const messages = db
      .prepare(
        `SELECT id,session_id,role,content,tool_call_id,tool_calls,tool_name,
      effect_disposition,timestamp,finish_reason,active FROM messages ORDER BY id`,
      )
      .all();
    const ids = new Set(sessions.map((session) => session.id));
    if (messages.some((message) => !ids.has(message.session_id)))
      throw new Error("The native Hermes transcript contains an unbound message.");
    const result = {
      source: "native_session_database",
      status: "retained",
      sessions,
      messages,
      approvalDecisions: "not_inferred_from_transcript",
      taskOutcome: "unverified",
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
      throw new Error("The native Hermes transcript exceeds the encoded comparison bound.");
    return result;
  } finally {
    db.close();
  }
}
