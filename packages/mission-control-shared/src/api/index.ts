/**
 * API barrel.
 *
 * Re-exports everything from the monolithic `client.ts` so that the rest
 * of the app can progressively migrate to domain-scoped imports:
 *
 *   import { fetchChatSessions } from "@/api";          // barrel
 *   import { fetchChatSessions } from "@/api/chat";     // domain slice
 *
 * Future passes will move bodies out of `client.ts` into the domain
 * files (chat.ts, approvals.ts, durable.ts, ...) while this barrel
 * keeps every existing import site working.
 */

export * from "./client.js";
export * from "./browser-sessions.js";
export * from "./review-readiness.js";
export * from "./trust.js";
export * from "./ops-quality.js";
export * from "./local-ai.js";
export * from "./model-comparisons.js";
export * from "./personal-ops.js";
