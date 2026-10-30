import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request: api.request }));

import { checkWhatsAppSetup, subscribeWhatsAppSetupApp } from "./channel-setup-operations.js";

const draftRef = { draftId: "11111111-1111-4111-8111-111111111111", expectedRevision: 3 };

describe("WhatsApp setup clients", () => {
  beforeEach(() => {
    api.request.mockReset();
  });

  it("posts a check with the draft, the ask and the code, and returns the answer as is", async () => {
    const answer = { number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" }, appSubscribed: true };
    api.request.mockResolvedValueOnce(answer);
    const input = { ...draftRef, askMeta: true, setupCode: "Kp4mZ9qRtW" };
    await expect(checkWhatsAppSetup(input)).resolves.toEqual(answer);
    expect(api.request).toHaveBeenCalledExactlyOnceWith("/api/v1/channels/whatsapp/setup-check", {
      method: "POST",
      body: JSON.stringify(input),
    });
  });

  it("posts a subscribe with only the draft", async () => {
    api.request.mockResolvedValueOnce({ appSubscribed: true });
    await expect(subscribeWhatsAppSetupApp(draftRef)).resolves.toEqual({ appSubscribed: true });
    expect(api.request).toHaveBeenCalledExactlyOnceWith("/api/v1/channels/whatsapp/setup-subscribe", {
      method: "POST",
      body: JSON.stringify(draftRef),
    });
  });
});
