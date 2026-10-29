import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { describe, expect, it } from "vitest";
import { SETUP_CODE_ALPHABET } from "./setup-code";
import {
  WHATSAPP_ADDRESS_CHECKED,
  WHATSAPP_ADDRESS_NOT_CHECKED,
  WHATSAPP_ADDRESS_WAITING,
  WHATSAPP_CATALOG_ID,
  WHATSAPP_CHECK_FAILED,
  WHATSAPP_CODE_EXPIRED,
  WHATSAPP_LISTEN_POLL_MS,
  WHATSAPP_WAITING_FOR_HI,
  createVerifyToken,
  savedAddressCheckedAt,
  savedWhatsAppSender,
  waMeLink,
  whatsAppDetailsProblem,
  whatsAppDraftWithSender,
  whatsAppFailure,
  type WhatsAppDetails,
} from "./whatsapp-setup-model";

const GOOD: WhatsAppDetails = {
  accessToken: "EAAB-ACCESS",
  phoneNumberId: "106540352242922",
  businessAccountId: "102290129340398",
  appId: "1234567890123456",
  appSecret: "0123456789abcdef",
};

const SENDER = { actorId: "16505551234", displayName: "Sheena" };

function httpError(status: number, body?: unknown): ApiRequestError {
  return new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/x", status, body });
}

describe("the words", () => {
  it("says each fixed sentence exactly", () => {
    expect(WHATSAPP_CATALOG_ID).toBe("channel.whatsapp");
    expect(WHATSAPP_CHECK_FAILED).toBe("GoatCitadel couldn't check those details with Meta.");
    expect(WHATSAPP_ADDRESS_WAITING).toBe("Waiting for Meta to check your address…");
    expect(WHATSAPP_ADDRESS_CHECKED).toBe("Meta checked your address just now.");
    expect(WHATSAPP_ADDRESS_NOT_CHECKED).toBe(
      "Meta hasn't checked your address yet. Choose Verify and save in Meta, then check again.",
    );
    expect(WHATSAPP_WAITING_FOR_HI).toBe("Waiting for your message…");
    expect(WHATSAPP_CODE_EXPIRED).toBe("The code ran out. Make a new one to try again.");
  });

  it("asks every 6 seconds, leaving half of the 20 calls a minute the check route allows for Meta checks", () => {
    expect(WHATSAPP_LISTEN_POLL_MS).toBe(6_000);
    expect(60_000 / WHATSAPP_LISTEN_POLL_MS).toBeLessThanOrEqual(10);
  });
});

describe("whatsAppDetailsProblem", () => {
  it("accepts five details of the right shape", () => {
    expect(whatsAppDetailsProblem(GOOD)).toBeUndefined();
  });

  it("names the first empty detail, in field order", () => {
    const empty = { accessToken: "", phoneNumberId: "", businessAccountId: "", appId: "", appSecret: "" };
    expect(whatsAppDetailsProblem(empty)).toBe("Paste the access token first.");
    expect(whatsAppDetailsProblem({ ...empty, accessToken: "t" })).toBe("Paste the Phone number ID first.");
    expect(whatsAppDetailsProblem({ ...empty, accessToken: "t", phoneNumberId: "123456" })).toBe(
      "Paste the WhatsApp Business Account ID first.",
    );
    expect(
      whatsAppDetailsProblem({ ...empty, accessToken: "t", phoneNumberId: "123456", businessAccountId: "123456" }),
    ).toBe("Paste the App ID first.");
    expect(whatsAppDetailsProblem({ ...GOOD, appSecret: "" })).toBe("Paste the App secret first.");
  });

  it("counts a detail that is only spaces as empty", () => {
    expect(whatsAppDetailsProblem({ ...GOOD, accessToken: "   \n" })).toBe("Paste the access token first.");
  });

  it("says an ID is digits only when it holds anything else", () => {
    expect(whatsAppDetailsProblem({ ...GOOD, phoneNumberId: "10654a352" })).toBe("Phone number ID is digits only.");
    expect(whatsAppDetailsProblem({ ...GOOD, businessAccountId: "+1 555 078 3881" })).toBe(
      "WhatsApp Business Account ID is digits only.",
    );
    expect(whatsAppDetailsProblem({ ...GOOD, appId: "app-123" })).toBe("App ID is digits only.");
  });

  it("reports the first problem of either kind, in field order", () => {
    expect(whatsAppDetailsProblem({ ...GOOD, accessToken: "", phoneNumberId: "abc" })).toBe(
      "Paste the access token first.",
    );
    expect(whatsAppDetailsProblem({ ...GOOD, businessAccountId: "abc", appId: "" })).toBe(
      "WhatsApp Business Account ID is digits only.",
    );
  });

  it("does not judge the shape of the two secrets", () => {
    expect(
      whatsAppDetailsProblem({ ...GOOD, accessToken: "not digits", appSecret: "not digits either" }),
    ).toBeUndefined();
  });
});

describe("createVerifyToken", () => {
  it("makes 32 characters from the letters and digits that are hard to mix up", () => {
    for (let index = 0; index < 25; index += 1) {
      const token = createVerifyToken();
      expect(token).toHaveLength(32);
      for (const character of token) expect(SETUP_CODE_ALPHABET).toContain(character);
    }
  });

  it("makes a different token every time", () => {
    expect(new Set(Array.from({ length: 50 }, () => createVerifyToken())).size).toBe(50);
  });
});

describe("waMeLink", () => {
  it("keeps only the digits of the number Meta shows, and carries the code as the message", () => {
    expect(waMeLink("+1 555-078-3881", "Kp4mZ9qRtW")).toBe("https://wa.me/15550783881?text=Kp4mZ9qRtW");
  });

  it("URL-encodes the text", () => {
    expect(waMeLink("+44 20 7946 0958", "a b&c")).toBe("https://wa.me/442079460958?text=a%20b%26c");
  });
});

describe("whatsAppDraftWithSender", () => {
  it("makes them the only sender, an owner, and where it posts, keeping the rest", () => {
    expect(whatsAppDraftWithSender({ label: "kept" }, SENDER)).toEqual({
      label: "kept",
      allowedSenders: ["16505551234"],
      ownerActorIds: ["16505551234"],
      inboundAccessMode: "allowlist",
      defaultTarget: "16505551234",
    });
  });

  it("does not change the values it is given", () => {
    const values = { label: "kept", allowedSenders: ["16500000000"] };
    const before = JSON.stringify(values);
    whatsAppDraftWithSender(values, SENDER);
    expect(JSON.stringify(values)).toBe(before);
  });

  it("replaces whoever said hi before", () => {
    const first = whatsAppDraftWithSender({}, { actorId: "16500000000" });
    const second = whatsAppDraftWithSender(first, SENDER);
    expect(second).toMatchObject({
      allowedSenders: ["16505551234"],
      ownerActorIds: ["16505551234"],
      defaultTarget: "16505551234",
    });
  });
});

describe("savedWhatsAppSender", () => {
  it("reads back who whatsAppDraftWithSender saved", () => {
    expect(savedWhatsAppSender(whatsAppDraftWithSender({ label: "kept" }, SENDER))).toEqual({
      actorId: "16505551234",
    });
  });

  it("is null before anyone has said hi", () => {
    expect(savedWhatsAppSender({})).toBeNull();
    expect(savedWhatsAppSender({ label: "kept" })).toBeNull();
  });

  it("is null without all four keys", () => {
    const saved = whatsAppDraftWithSender({}, SENDER);
    for (const key of ["allowedSenders", "ownerActorIds", "inboundAccessMode", "defaultTarget"]) {
      const { [key]: _removed, ...without } = saved;
      expect(savedWhatsAppSender(without), key).toBeNull();
    }
  });

  it("is null when the sender is not among the allowed ones, or the mode is not an allowlist", () => {
    const saved = whatsAppDraftWithSender({}, SENDER);
    expect(savedWhatsAppSender({ ...saved, allowedSenders: ["16500000000"] })).toBeNull();
    expect(savedWhatsAppSender({ ...saved, inboundAccessMode: "open" })).toBeNull();
    expect(savedWhatsAppSender({ ...saved, ownerActorIds: [" ", 7] })).toBeNull();
  });
});

describe("savedAddressCheckedAt", () => {
  it("reads the time the page noted on the draft", () => {
    expect(savedAddressCheckedAt({ webhookCheckedAt: "2026-10-29T10:00:00.000Z" })).toBe("2026-10-29T10:00:00.000Z");
  });

  it("is undefined when nothing was noted, or what was noted is not a time", () => {
    expect(savedAddressCheckedAt({})).toBeUndefined();
    expect(savedAddressCheckedAt({ webhookCheckedAt: "" })).toBeUndefined();
    expect(savedAddressCheckedAt({ webhookCheckedAt: 12 })).toBeUndefined();
  });
});

describe("whatsAppFailure", () => {
  it("says the sentence GoatCitadel sent with a 400", () => {
    expect(whatsAppFailure(httpError(400, { error: "Meta didn't accept the access token." }))).toBe(
      "Meta didn't accept the access token.",
    );
    expect(whatsAppFailure(httpError(400, { message: "That access token was made for a different Meta app." }))).toBe(
      "That access token was made for a different Meta app.",
    );
  });

  it("says the fixed sentence for a 400 with nothing to say", () => {
    expect(whatsAppFailure(httpError(400))).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure(httpError(400, {}))).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure(httpError(400, { error: "  " }))).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure(httpError(400, { error: { fieldErrors: { draftId: ["Invalid"] } } }))).toBe(
      WHATSAPP_CHECK_FAILED,
    );
  });

  it("does not repeat a 400 that is not a sentence", () => {
    expect(whatsAppFailure(httpError(400, { error: "Bad Request" }))).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure(httpError(400, { error: `body/draftId must match format "uuid".${"x".repeat(400)}` }))).toBe(
      WHATSAPP_CHECK_FAILED,
    );
  });

  it("says the fixed sentence for every other failure, never what it carried", () => {
    const leak = { error: "Meta said: Bearer EAAB-SECRET-TOKEN." };
    for (const status of [401, 403, 404, 409, 429, 500, 502]) {
      expect(whatsAppFailure(httpError(status, leak)), String(status)).toBe(WHATSAPP_CHECK_FAILED);
    }
    expect(whatsAppFailure(new Error("Authorization: Bearer EAAB-SECRET-TOKEN"))).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure("Bearer EAAB-SECRET-TOKEN")).toBe(WHATSAPP_CHECK_FAILED);
    expect(whatsAppFailure(undefined)).toBe(WHATSAPP_CHECK_FAILED);
  });
});
