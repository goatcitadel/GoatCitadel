import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(
    async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("reads by id", () => {
  let fetchMock: ReturnType<typeof stubFetch>;
  let fetchApproval: (typeof import("./approvals"))["fetchApproval"];
  let fetchTraceMemoryCandidate: (typeof import("./memory"))["fetchTraceMemoryCandidate"];
  let fetchDurableDeadLetter: (typeof import("./durable"))["fetchDurableDeadLetter"];
  let fetchDocumentPatchProposal: (typeof import("./chat"))["fetchDocumentPatchProposal"];

  beforeEach(async () => {
    fetchMock = stubFetch();
    ({ fetchApproval } = await import("./approvals"));
    ({ fetchTraceMemoryCandidate } = await import("./memory"));
    ({ fetchDurableDeadLetter } = await import("./durable"));
    ({ fetchDocumentPatchProposal } = await import("./chat"));
  });

  it("address one record, keep workspace scope and forward cancellation", async () => {
    const controller = new AbortController();

    await fetchApproval("approval/1", { workspaceId: "ws-a", signal: controller.signal });
    await fetchTraceMemoryCandidate("candidate-1", { workspaceId: "ws-a" });
    await fetchDurableDeadLetter("dead-1", { signal: controller.signal });
    await fetchDocumentPatchProposal("proposal-1", { workspaceId: "ws a" });

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls[0]).toContain("/api/v1/approvals/approval%2F1?workspaceId=ws-a");
    expect(urls[1]).toContain("/api/v1/memory/trace-candidates/candidate-1?workspaceId=ws-a");
    expect(urls[2]).toContain("/api/v1/durable/dead-letters/dead-1");
    expect(urls[3]).toContain("/api/v1/chat/document-patch-proposals/proposal-1?workspaceId=ws%20a");
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: controller.signal });
  });
});
