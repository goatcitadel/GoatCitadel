import { projectOpenclawComparisonTurn } from "./agent-comparison-openclaw-workflow.mjs";
import {
  createNativeWebAcceptance,
  nativeJson,
  nativeTimestamp,
  requireNative,
} from "./agent-comparison-acceptance-native.mjs";
import { FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { bindNativeRecoveryConfiguration } from "./agent-comparison-native-recovery-binding.mjs";
import { readOpenclawRecoveryEvidence } from "./agent-comparison-native-recovery-evidence.mjs";
export const product = "openclaw";
export const revision = FEATURE_ACCEPTANCE_PINS.openclaw;

export const bindRecoveryConfiguration = (input) => bindNativeRecoveryConfiguration({ ...input, product, revision });

// Pinned native agent RPC terminal receipt + exact chat.history tool-call joins.
// Search/fetch schemas come from src/agents/tools/web-{search-output,fetch}.ts.
export function projectOpenclawAcceptanceWeb(native, { model, workspace, prompt }) {
  const turn = projectOpenclawComparisonTurn(native.result, { sessionKey: native.sessionKey, model, workspace });
  const history = native.history;
  requireNative(
    history?.sessionKey === native.sessionKey &&
      history.sessionId === turn.sessionId &&
      history.hasMore !== true &&
      !history.nextOffset &&
      history.sessionInfo?.hasActiveRun !== true &&
      Array.isArray(history.messages) &&
      history.messages.length <= 500,
    "The OpenClaw native transcript is incomplete or belongs to another session.",
  );
  const users = history.messages.filter((message) => message.role === "user");
  const content = (message) =>
    typeof message.content === "string"
      ? message.content
      : message.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  requireNative(
    users.length === 1 && content(users[0]).trim() === prompt.trim(),
    "The native OpenClaw transcript does not bind this fresh prompt.",
  );
  const calls = history.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "toolCall") : [],
    );
  requireNative(
    new Set(calls.map((call) => call.id)).size === calls.length,
    "Native OpenClaw tool calls are duplicated.",
  );
  const records = [];
  for (const call of calls) {
    if (!["web_search", "web_fetch"].includes(call.name)) continue;
    const matches = history.messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId === call.id,
    );
    requireNative(
      matches.length === 1 && matches[0].toolName === call.name && matches[0].isError !== true,
      "Native OpenClaw web call is unsettled, failed or duplicated.",
    );
    const value = nativeJson(matches[0].content),
      at = nativeTimestamp(matches[0].timestamp);
    if (call.name === "web_search") {
      requireNative(
        value.kind === "results" && value.query === call.arguments?.query && Array.isArray(value.results),
        "Native OpenClaw search changed its query or result shape.",
      );
      records.push({
        kind: "web_search",
        id: `openclaw-${call.id}`,
        at,
        query: value.query,
        resultUrls: value.results.map((result) => result.url),
      });
    } else {
      requireNative(
        value.url === call.arguments?.url &&
          value.status === 200 &&
          typeof value.text === "string" &&
          value.truncated === false,
        "Native OpenClaw fetch is incomplete or changed URL.",
      );
      records.push({
        kind: "web_source",
        id: `openclaw-${call.id}`,
        at,
        url: value.url,
        status: value.status,
        text: value.text,
        contentSha256: sha256(value.text),
      });
    }
  }
  return { records };
}
export const createAcceptanceActions = (options) =>
  createNativeWebAcceptance({
    ...options,
    product,
    project: projectOpenclawAcceptanceWeb,
    readRecovery: readOpenclawRecoveryEvidence,
  });
