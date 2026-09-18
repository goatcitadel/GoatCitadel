import { expect, it } from "vitest";
import { normalizeRemoteWorkerNativeChatHistory as normalize, remoteWorkerNativeChatHistorySha256 } from "./remote-worker-native-chat-history.js";
const value = { schemaVersion: "goatcitadel.remote-worker-native-chat-history.v1", nativeContextSha256: "a".repeat(64),
  contextSnapshotSha256: "b".repeat(64), priorModelSteps: 1, priorRequestSha256s: ["c".repeat(64)],
  usageEventIds: ["usage-1"], messages: [{ role: "user", text: "Original task" }, { role: "assistant", text: "Earlier result" }] };

it("normalizes an immutable history snapshot and binds every message and consumed request", () => {
  const result = normalize(value);
  expect(Object.isFrozen(result)).toBe(true);
  expect(remoteWorkerNativeChatHistorySha256(result)).not.toBe(remoteWorkerNativeChatHistorySha256(normalize({ ...value,
    messages: [{ role: "user", text: "different" }] })));
  expect(normalize({ ...value, priorModelSteps: 0, priorRequestSha256s: [], usageEventIds: [] }).priorModelSteps).toBe(0);
});

it.each([
  { priorModelSteps: 17 }, { priorModelSteps: 0 }, { priorRequestSha256s: [] }, { usageEventIds: [] },
  { nativeContextSha256: "0".repeat(64) }, { rawOutput: "not a field" }, { messages: [] },
])("rejects unbound or incomplete history: %j", patch => expect(() => normalize({ ...value, ...patch })).toThrow());

it("rejects accessor fields without invoking them", () => {
  let invoked = false;
  const input = { ...value };
  Object.defineProperty(input, "messages", { enumerable: true, get() { invoked = true; return []; } });
  expect(() => normalize(input)).toThrow();
  expect(invoked).toBe(false);
  const requests = ["c".repeat(64)];
  Object.defineProperty(requests, "0", { enumerable: true, get() { invoked = true; return "c".repeat(64); } });
  expect(() => normalize({ ...value, priorRequestSha256s: requests })).toThrow();
  expect(invoked).toBe(false);
});
