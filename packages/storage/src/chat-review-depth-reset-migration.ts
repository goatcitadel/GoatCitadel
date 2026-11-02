/**
 * Chat's "Review answer" (`orchestration_review_depth`) used to default to 'standard' while no runtime read it.
 * Answer review now runs a reviewer model call on each turn, so every stored value is reset to 'off' once:
 * a row cannot tell an operator's choice from the old default, and nobody relied on a value that did nothing.
 * Operators turn review on again per session. The column DEFAULT is left as is; every insert names the value.
 */
export const RESET_CHAT_REVIEW_DEPTH_SQLITE_SQL = `UPDATE chat_session_prefs
  SET orchestration_review_depth = 'off'
  WHERE orchestration_review_depth <> 'off';`;

export const RESET_CHAT_REVIEW_DEPTH_POSTGRES_SQL = `UPDATE chat_session_prefs
  SET orchestration_review_depth = 'off'
  WHERE orchestration_review_depth <> 'off';`;
