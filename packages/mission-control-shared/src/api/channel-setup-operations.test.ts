import { describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: api.request }));
import { fetchChannelSetupDraftEvidence } from "./channel-setup-operations.js";
describe("channel setup draft evidence client", () => {
  it("reads an exact encoded draft snapshot without caching or posting", async () => {
    const response = { draftId: "draft/one", draftRevision: 7, items: [] }; api.request.mockResolvedValueOnce(response);
    expect(await fetchChannelSetupDraftEvidence("draft/one", 7)).toEqual(response);
    expect(api.request).toHaveBeenCalledExactlyOnceWith("/api/v1/channels/drafts/draft%2Fone/evidence?expectedRevision=7", { cache: "no-store" });
  });
});
