/**
 * Chat domain slice.
 *
 * Pilot domain file for the api/client.ts split. Re-exports chat-
 * related functions from client.ts unchanged. Future pass can move
 * bodies here; for now this is a pure re-export façade so callers can
 * start importing from `@/api/chat` incrementally.
 */

export {
  // projects
  fetchChatProjects,
  createChatProject,
  updateChatProject,
  archiveChatProject,
  restoreChatProject,
  hardDeleteChatProject,
  // sessions
  fetchChatSessions,
  createChatSession,
  archiveWorkspaceChatSessions,
  updateChatSession,
  deleteChatSession,
  pinChatSession,
  unpinChatSession,
  archiveChatSession,
  restoreChatSession,
  assignChatSessionProject,
  setChatSessionBinding,
  fetchChatSessionBinding,
  // messages + thread
  fetchChatMessages,
  fetchChatThread,
  sendAgentChatMessage,
  streamAgentChatMessage,
  selectChatBranchTurn,
  // turns
  retryChatTurn,
  streamRetryChatTurn,
  editChatTurn,
  streamEditChatTurn,
  resumeChatTurnStream,
  cancelChatTurn,
  // prefs
  fetchChatSessionPrefs,
  updateChatSessionPrefs,
  // proactive
  fetchChatProactiveStatus,
  updateChatProactivePolicy,
  triggerChatProactive,
  fetchChatProactiveRuns,
  // approvals on chat
  approveChatTool,
  denyChatTool,
  // attachments
  uploadChatAttachment,
  fetchChatAttachment,
  downloadChatAttachment,
  fetchChatAttachmentPreview,
} from "./client.js";
