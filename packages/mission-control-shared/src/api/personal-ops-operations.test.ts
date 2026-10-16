import { describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: api.request }));
import { getMailDraft, sendMailDraft } from "./personal-ops-operations.js";

describe("mail draft read-back client", () => {
  it("reads one encoded draft fresh in its workspace without posting", async () => {
    const draft = { draftId: "mail/draft one", status: "approval_required" };
    api.request.mockResolvedValueOnce(draft);

    expect(await getMailDraft("mail/draft one", "work space")).toEqual(draft);
    expect(api.request).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/mail/drafts/mail%2Fdraft%20one?workspaceId=work+space",
      { cache: "no-store" },
    );
  });

  it("always names the owning workspace on a send", async () => {
    api.request.mockReset();
    api.request.mockResolvedValue({ draftId: "d1", status: "approval_required" });

    await sendMailDraft("d1", "workspace-1");

    expect(api.request.mock.calls).toEqual([
      ["/api/v1/mail/drafts/d1/send", { method: "POST", body: JSON.stringify({ workspaceId: "workspace-1" }) }],
    ]);
  });
});
