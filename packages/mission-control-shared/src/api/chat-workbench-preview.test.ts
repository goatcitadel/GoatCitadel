import { describe, expect, it, vi } from "vitest";
import { fetchChatSessionWorkbench, fetchChatSessionWorkbenchFile, fetchChatSessionWorkbenchTree } from "./chat.js";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: mocks.request }));

describe("workbench preview reads", () => {
  it("opts into preview mode while retaining the existing default URLs", async () => {
    await fetchChatSessionWorkbench("session/a", { preview: true });
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench?preview=true");
    await fetchChatSessionWorkbenchTree("session/a", { preview: true });
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench/tree?preview=true");
    await fetchChatSessionWorkbenchFile("session/a", "a & b.txt", { preview: true });
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench/file?path=a+%26+b.txt&preview=true");
    await fetchChatSessionWorkbench("session/a");
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench");
    await fetchChatSessionWorkbenchTree("session/a");
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench/tree");
    await fetchChatSessionWorkbenchFile("session/a", "a & b.txt");
    expect(mocks.request).toHaveBeenLastCalledWith("/api/v1/chat/sessions/session%2Fa/workbench/file?path=a+%26+b.txt");
  });
});
