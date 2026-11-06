import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as chat from "./chat.js";
import * as workbench from "./chat-workbench-operations.js";

const transport = vi.hoisted(() => ({ request: vi.fn(), headers: vi.fn(), authRejected: vi.fn() }));
vi.mock("./client-core.js", () => ({
  request: transport.request,
  buildGatewayUrl: (path: string) => "https://gateway.example" + path,
  buildGatewayHeaders: transport.headers,
  handleGatewayAuthRejectionResponse: transport.authRejected,
  readGatewayAuthHeaders: () => ({}),
}));
vi.mock("../state/dev-diagnostics-store", () => ({ createCorrelationId: () => "test-correlation", recordClientDiagnostic: vi.fn() }));
const reads = ["fetchChatSessionWorkbench", "fetchChatSessionWorkbenchTree", "fetchChatSessionWorkbenchFile", "fetchChatSessionWorkbenchFileDiff", "fetchChatSessionWorkbenchDiff", "fetchChatSessionWorkbenchOutput"] as const;
const sessionId = "session/a & b";
const encoded = "session%2Fa%20%26%20b";
const request = { objective: "Review", roles: ["Coder"], mode: "sequential", surfaceMode: "cowork" } as Parameters<typeof chat.runChatDelegation>[1];
function events(...chunks: unknown[]) {
  const text = ": keepalive\n\n" + chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const split = Math.floor(bytes.length / 3);
    controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
beforeEach(() => { vi.clearAllMocks(); transport.request.mockResolvedValue({ canonical: true }); transport.headers.mockReturnValue({ authorization: "test-auth" }); });
afterEach(() => { vi.unstubAllGlobals(); });
describe("optional chat API facade contracts", () => {
  it.each(reads)("keeps the existing workbench implementation identity for %s", name => {
    expect(chat[name]).toBe((workbench as Record<string, unknown>)[name]);
  });
  it("preserves every workbench read URL, preview option and path query", async () => {
    const path = "src/a & b.ts";
    const calls: Array<[() => Promise<unknown>, string]> = [
      [() => chat.fetchChatSessionWorkbench(sessionId), "/workbench"],
      [() => chat.fetchChatSessionWorkbench(sessionId, { preview: true }), "/workbench?preview=true"],
      [() => chat.fetchChatSessionWorkbenchTree(sessionId), "/workbench/tree"],
      [() => chat.fetchChatSessionWorkbenchTree(sessionId, { preview: true }), "/workbench/tree?preview=true"],
      [() => chat.fetchChatSessionWorkbenchFile(sessionId, path), "/workbench/file?path=src%2Fa+%26+b.ts"],
      [() => chat.fetchChatSessionWorkbenchFile(sessionId, path, { preview: true }), "/workbench/file?path=src%2Fa+%26+b.ts&preview=true"],
      [() => chat.fetchChatSessionWorkbenchFileDiff(sessionId, path), "/workbench/file-diff?path=src%2Fa+%26+b.ts"],
      [() => chat.fetchChatSessionWorkbenchDiff(sessionId), "/workbench/diff"],
      [() => chat.fetchChatSessionWorkbenchOutput(sessionId), "/workbench/output"],
    ];
    for (const [invoke, suffix] of calls) {
      expect(await invoke()).toEqual({ canonical: true });
      expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + suffix);
    }
  });
  it("preserves delegation, research, suggestion and proactive bodies without adding defaults", async () => {
    await chat.runChatDelegation(sessionId, request);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/delegate", { method: "POST", headers: { "x-goatcitadel-origin-surface": "chat" }, body: JSON.stringify(request) });
    const research = { query: "source grounded", mode: "deep" as const, policyRunId: "parent", providerId: "provider", model: "model" };
    await chat.runChatResearch(sessionId, research);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/research/run", { method: "POST", body: JSON.stringify(research) });
    await chat.suggestChatDelegation(sessionId);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/delegate/suggest", { method: "POST", body: "{}" });
    await chat.suggestChatDelegation(sessionId, { objective: "one exact request" });
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/delegate/suggest", { method: "POST", body: JSON.stringify({ objective: "one exact request" }) });
    await chat.triggerChatProactive(sessionId);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/proactive/trigger", { method: "POST", body: "{}" });
    const proactive = { source: "manual" as const, reason: "operator", surface: "chat" as const };
    await chat.triggerChatProactive(sessionId, proactive);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/proactive/trigger", { method: "POST", body: JSON.stringify(proactive) });
  });
  it("retains ordinary request failure identity", async () => {
    const failure = new Error("canonical request failed");
    transport.request.mockRejectedValueOnce(failure);
    await expect(chat.runChatDelegation(sessionId, request)).rejects.toBe(failure);
  });
  it("keeps an omitted origin absent instead of adding a surface default", async () => {
    const { surfaceMode: _surface, ...withoutSurface } = request;
    await chat.runChatDelegation(sessionId, withoutSurface);
    expect(transport.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/delegate", { method: "POST", body: JSON.stringify(withoutSurface) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(events({ type: "done", result: { runId: "run", steps: [] } })));
    await chat.streamChatDelegation(sessionId, withoutSurface, () => undefined);
    expect(transport.headers).toHaveBeenLastCalledWith("/api/v1/chat/sessions/" + encoded + "/delegate/stream", "POST", "test-correlation", { "x-goatcitadel-session-id": sessionId });
  });
  it("retains exact stream delivery, normalized origin/auth headers and observation signal", async () => {
    const chunks = [{ type: "status", runId: "run", message: "started" }, { type: "step", step: { stepId: "step", runId: "run", role: "Coder", status: "running", index: 0, startedAt: "now", scopeControl: { approvedPaths: ["src"], scopeHash: "hash" } } }, { type: "done", result: { runId: "run", stitchedOutput: "complete", steps: [] } }];
    const fetch = vi.fn().mockResolvedValueOnce(events(...chunks)); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); const received: unknown[] = [];
    await chat.streamChatDelegation(sessionId, request, chunk => received.push(chunk), { signal: controller.signal });
    const path = "/api/v1/chat/sessions/" + encoded + "/delegate/stream";
    expect(transport.headers).toHaveBeenCalledExactlyOnceWith(path, "POST", "test-correlation", { "x-goatcitadel-session-id": sessionId, "x-goatcitadel-origin-surface": "chat" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://gateway.example" + path, { method: "POST", headers: { authorization: "test-auth" }, body: JSON.stringify(request), signal: controller.signal });
    expect(received).toEqual(chunks);
  });
  it("delivers error chunks before rejecting with the final stream error", async () => {
    const chunks = [{ type: "error", error: "first error" }, { type: "status", message: "cleanup" }, { type: "error", error: "final error" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(events(...chunks)));
    const received: unknown[] = [];
    await expect(chat.streamChatDelegation(sessionId, request, chunk => received.push(chunk))).rejects.toThrow("final error");
    expect(received).toEqual(chunks);
  });
  it("preserves auth rejection handling and exact HTTP failure text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("denied", { status: 401 })));
    await expect(chat.streamChatDelegation(sessionId, request, () => undefined)).rejects.toThrow("API error 401: denied");
    expect(transport.authRejected).toHaveBeenCalledExactlyOnceWith(401, "denied", "/api/v1/chat/sessions/" + encoded + "/delegate/stream");
  });
  it("preserves transport abort error identity", async () => {
    const error = new DOMException("observation cancelled", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error));
    await expect(chat.streamChatDelegation(sessionId, request, () => undefined)).rejects.toBe(error);
  });
});
