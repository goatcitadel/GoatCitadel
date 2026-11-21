import { expect, it, vi } from "vitest";
import type { ChatCompletionRequest } from "@goatcitadel/contracts";
import { resolveChatLearningMemoryManifest } from "./chat-learning-memory-manifest.js";

const hash = "a".repeat(64);
const instruction =
  "Operator profile (durable; persists across sessions):\n\nPreferences:\n- Concise replies [memory_learning:learning-1 sha256:" +
  hash +
  "]";
function fixture() {
  return {
    storage: {
      sessions: { getBySessionId: vi.fn(async () => ({ sessionId: "session", kind: "dm" })) },
      chatSessionMeta: {
        get: vi.fn(async () => ({ workspaceId: "workspace", lifecycleStatus: "active", origin: "operator" })),
      },
    },
    isEnabled: vi.fn(async () => true),
    composeContext: vi.fn(async () => ({ instruction, sources: [{ learningId: "learning-1", sourceHash: hash }] })),
  };
}
const request = (content: unknown = instruction) =>
  ({
    model: "fixture",
    memory: { enabled: true, sessionId: "session" },
    messages: [
      { role: "system", content },
      { role: "user", content: "Hi." },
    ],
  }) as ChatCompletionRequest;

it("records only current full-hash sources from a standing profile actually included in system context", async () => {
  const result = await resolveChatLearningMemoryManifest(
    fixture() as never,
    request("Runtime instructions\n\n" + instruction),
  );
  expect(result).toEqual({ instruction, sources: [{ learningId: "learning-1", sourceHash: hash }] });
});
it("handles structured cached text blocks without treating user text as source admission", async () => {
  expect(
    await resolveChatLearningMemoryManifest(fixture() as never, request([{ type: "text", text: instruction }])),
  ).toBeDefined();
  const body = request("No standing profile here.");
  body.messages.push({ role: "user", content: instruction });
  const deps = fixture();
  expect(await resolveChatLearningMemoryManifest(deps as never, body)).toBeUndefined();
  expect(deps.composeContext).not.toHaveBeenCalled();
});
it("does not count legacy hashless markers as verified admission", async () => {
  expect(
    await resolveChatLearningMemoryManifest(fixture() as never, request(instruction.replace(" sha256:" + hash, ""))),
  ).toBeUndefined();
});
it.each(["forgotten", "changed", "foreign", "disabled", "off", "missing"])(
  "refuses stale or unauthorized standing-profile egress: %s",
  async (kind) => {
    const deps = fixture(),
      body = request();
    if (kind === "forgotten")
      deps.composeContext.mockResolvedValue({ instruction: "No saved preference.", sources: [] });
    if (kind === "changed")
      deps.composeContext.mockResolvedValue({
        instruction: instruction.replace(hash, "b".repeat(64)),
        sources: [{ learningId: "learning-1", sourceHash: "b".repeat(64) }],
      });
    if (kind === "foreign") {
      deps.storage.chatSessionMeta.get.mockResolvedValue({
        workspaceId: "foreign",
        lifecycleStatus: "active",
        origin: "operator",
      });
      deps.composeContext.mockImplementation(async (workspaceId?: string) =>
        workspaceId === "workspace"
          ? { instruction, sources: [{ learningId: "learning-1", sourceHash: hash }] }
          : (undefined as never),
      );
    }
    if (kind === "disabled") deps.isEnabled.mockResolvedValue(false);
    if (kind === "off") body.memory!.enabled = false;
    if (kind === "missing") deps.storage.chatSessionMeta.get.mockResolvedValue(undefined as never);
    await expect(resolveChatLearningMemoryManifest(deps as never, body)).rejects.toThrow(
      /saved preferences.*changed|changed.*saved preferences/i,
    );
  },
);
