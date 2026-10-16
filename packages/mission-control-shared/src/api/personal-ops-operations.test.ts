import { describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: api.request }));
import { getMailDraft } from "./personal-ops-operations.js";

describe("mail draft read-back client", () => {
  it("reads one encoded draft fresh without posting", async () => {
    const draft = { draftId: "mail/draft one", status: "approval_required" };
    api.request.mockResolvedValueOnce(draft);

    expect(await getMailDraft("mail/draft one")).toEqual(draft);
    expect(api.request).toHaveBeenCalledExactlyOnceWith("/api/v1/mail/drafts/mail%2Fdraft%20one", {
      cache: "no-store",
    });
  });
});
