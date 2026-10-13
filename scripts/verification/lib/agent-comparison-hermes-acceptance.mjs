import { projectHermesComparisonTurn } from "./agent-comparison-hermes-workflow.mjs";
import {
  createNativeWebAcceptance,
  nativeJson,
  nativeTimestamp,
  requireNative,
} from "./agent-comparison-acceptance-native.mjs";
import { FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { bindNativeRecoveryConfiguration } from "./agent-comparison-native-recovery-binding.mjs";
import { readHermesRecoveryEvidence } from "./agent-comparison-native-recovery-evidence.mjs";
export const product = "hermes";
export const revision = FEATURE_ACCEPTANCE_PINS.hermes;

export const bindRecoveryConfiguration = (input) => bindNativeRecoveryConfiguration({ ...input, product, revision });

// Native SQLite user-message IDs identify turns at this pin. The CLI process
// must stop successfully before the existing read-only transcript owner reads it.
export function projectHermesAcceptanceWeb(native, { model, workspace, prompt }) {
  requireNative(
    native.process?.exitCode === 0 && native.process.cleanupUnconfirmed === false,
    "The native Hermes process did not stop successfully with confirmed cleanup.",
  );
  const turn = projectHermesComparisonTurn(native.transcript, { model, workspace, prompt });
  const calls = turn.messages.flatMap((message) => (message.tool_calls ? nativeJson(message.tool_calls) : []));
  requireNative(
    new Set(calls.map((call) => call.id)).size === calls.length,
    "Native Hermes tool calls are duplicated.",
  );
  const records = [];
  for (const call of calls) {
    if (!["web_search", "web_extract"].includes(call.function?.name)) continue;
    const matches = turn.messages.filter((message) => message.role === "tool" && message.tool_call_id === call.id);
    requireNative(
      matches.length === 1 && matches[0].tool_name === call.function.name,
      "Native Hermes web call has no exact settled result.",
    );
    const args = nativeJson(call.function.arguments),
      value = nativeJson(matches[0].content),
      at = nativeTimestamp(matches[0].timestamp);
    if (call.function.name === "web_search") {
      requireNative(
        value.success === true && Array.isArray(value.data?.web) && typeof args.query === "string",
        "Native Hermes search failed or changed shape.",
      );
      records.push({
        kind: "web_search",
        id: `hermes-${call.id}`,
        at,
        query: args.query,
        resultUrls: value.data.web.map((result) => result.url),
      });
    } else {
      requireNative(
        Array.isArray(args.urls) && Array.isArray(value.results) && value.results.length === args.urls.length,
        "Native Hermes extraction result is incomplete.",
      );
      for (const [index, result] of value.results.entries()) {
        requireNative(
          args.urls.includes(result.url) &&
            !result.error &&
            typeof result.content === "string" &&
            result.content.length > 0,
          "Native Hermes extraction failed or changed its requested URL.",
        );
        // Hermes exposes extraction success/content, not an HTTP status. Never
        // invent 200; the verifier recognizes this product-specific evidence.
        records.push({
          kind: "web_source",
          id: `hermes-${call.id}-${index}`,
          at,
          url: result.url,
          sourceEvidence: "hermes_native_extraction",
          status: null,
          extractionSucceeded: true,
          text: result.content,
          contentSha256: sha256(result.content),
        });
      }
    }
  }
  return { records };
}
export const createAcceptanceActions = (options) =>
  createNativeWebAcceptance({
    ...options,
    product,
    project: projectHermesAcceptanceWeb,
    readRecovery: readHermesRecoveryEvidence,
  });
