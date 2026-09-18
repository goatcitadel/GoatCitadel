import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import { REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS } from "./remote-worker-chat-workflow.js";
import { normalizeRemoteWorkerInferenceMessages, normalizeRemoteWorkerInferenceUsageEventIds,
  type RemoteWorkerInferenceMessage } from "./remote-worker-inference.js";

export interface RemoteWorkerNativeChatHistory {
  readonly schemaVersion: "goatcitadel.remote-worker-native-chat-history.v1";
  readonly nativeContextSha256: string;
  readonly contextSnapshotSha256: string;
  readonly priorModelSteps: number;
  readonly priorRequestSha256s: readonly string[];
  readonly usageEventIds: readonly string[];
  readonly messages: readonly RemoteWorkerInferenceMessage[];
}

function dataArray(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum)
    throw new TypeError("Native Chat history array is invalid.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== input.length + 1) throw new TypeError("Native Chat history array is invalid.");
  return Array.from({ length: input.length }, (_, index) => {
    const field = descriptors[index];
    if (!field?.enumerable || !("value" in field)) throw new TypeError("Native Chat history array is invalid.");
    return field.value;
  });
}

export function normalizeRemoteWorkerNativeChatHistory(input: unknown): RemoteWorkerNativeChatHistory {
  const keys = ["schemaVersion", "nativeContextSha256", "contextSnapshotSha256", "priorModelSteps", "priorRequestSha256s", "usageEventIds", "messages"];
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new TypeError("Native Chat history is invalid.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key])))
    throw new TypeError("Native Chat history is invalid.");
  const value = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  const requests = dataArray(value.priorRequestSha256s, REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS);
  const usage = dataArray(value.usageEventIds, 32);
  const hash = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s) && !/^0+$/u.test(s);
  if (value.schemaVersion !== "goatcitadel.remote-worker-native-chat-history.v1" || !hash(value.nativeContextSha256) ||
    !hash(value.contextSnapshotSha256) || !Number.isSafeInteger(value.priorModelSteps) || value.priorModelSteps < 0 ||
    value.priorModelSteps > REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS || requests.length !== value.priorModelSteps ||
    requests.some(s => !hash(s)) || new Set(requests).size !== value.priorModelSteps || usage.some(id => typeof id !== "string"))
    throw new TypeError("Native Chat history is invalid.");
  const usageEventIds = usage.length ? normalizeRemoteWorkerInferenceUsageEventIds(usage as string[]) : Object.freeze([]);
  if ((value.priorModelSteps === 0) !== (usageEventIds.length === 0)) throw new TypeError("Native Chat history lacks canonical usage identities.");
  return Object.freeze({ schemaVersion: value.schemaVersion, nativeContextSha256: value.nativeContextSha256,
    contextSnapshotSha256: value.contextSnapshotSha256, priorModelSteps: value.priorModelSteps,
    priorRequestSha256s: Object.freeze(requests as string[]), usageEventIds,
    messages: normalizeRemoteWorkerInferenceMessages(value.messages) });
}

export function remoteWorkerNativeChatHistorySha256(input: RemoteWorkerNativeChatHistory): string {
  return sha256Hex(canonicalJsonString(normalizeRemoteWorkerNativeChatHistory(input)));
}
