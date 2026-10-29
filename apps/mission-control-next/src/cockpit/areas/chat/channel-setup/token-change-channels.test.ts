// @vitest-environment happy-dom
import type { ChannelSetupDraft, WhatsAppSetupCheckResult } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_CHANGE_CHANNELS } from "./token-change-channels";
import { WHATSAPP_CATALOG_ID, WHATSAPP_CHECK_FAILED, WHATSAPP_TURN_ON_WORDING } from "./whatsapp-setup-model";

const api = vi.hoisted(() => ({
  checkDiscordSetup: vi.fn(),
  checkSlackSetup: vi.fn(),
  checkWhatsAppSetup: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const WHATSAPP = TOKEN_CHANGE_CHANNELS.get("whatsapp")!;
const ACCESS_TOKEN = "EAAG-NEW-SECRET-ACCESS-TOKEN";
const PHONE_NUMBER_ID = "106540352242922";
const REF = { draftId: "rotate-1", expectedRevision: 2 };
const NUMBER = { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" };

function rotateDraft(values: Record<string, unknown> = { phoneNumberId: PHONE_NUMBER_ID }): ChannelSetupDraft {
  return {
    draftId: "rotate-1",
    revision: 2,
    catalogId: WHATSAPP_CATALOG_ID,
    connectionId: "conn-1",
    connectionRevision: "a".repeat(64),
    lifecycleMode: "rotate_secret",
    enabled: true,
    draft: values,
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T09:00:00.000Z",
  };
}

const found = (overrides: Partial<WhatsAppSetupCheckResult> = {}): WhatsAppSetupCheckResult => ({
  number: NUMBER,
  appSubscribed: true,
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.checkWhatsAppSetup.mockResolvedValue(found());
  api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft());
});

/** The error a check ends in, so a test can look at everything it carries. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

describe("the channels whose key is changed on ChannelTokenChange", () => {
  it("are Discord, Slack and WhatsApp, by catalog key", () => {
    expect([...TOKEN_CHANGE_CHANNELS.keys()].sort()).toEqual(["discord", "slack", "whatsapp"]);
    for (const [key, channel] of TOKEN_CHANGE_CHANNELS) expect(channel.key).toBe(key);
  });
});

describe("the WhatsApp entry", () => {
  it("is titled for its access token, and follows the number it saved", () => {
    expect(WHATSAPP.catalogId).toBe(WHATSAPP_CATALOG_ID);
    expect(WHATSAPP.title).toBe("Change WhatsApp's access token");
    expect(WHATSAPP.savedBotKey).toBe("phoneNumberId");
    expect(WHATSAPP.many).toBe(false);
    expect(WHATSAPP.failed).toBe(WHATSAPP_CHECK_FAILED);
    // Nothing reports a name for the number the running channel uses, so a warning would not name it.
    expect(WHATSAPP.runningBotNameKey).toBeUndefined();
  });

  it("saves in WhatsApp's words, and says where to delete the test message it cannot take back", () => {
    expect(WHATSAPP.wording).toMatchObject({
      button: "Save key",
      done: "Saved. WhatsApp uses the new token now.",
      doneLink: "Back to WhatsApp's page",
      cleanup: WHATSAPP_TURN_ON_WORDING.cleanup,
    });
  });

  it("lists the test message truthfully: the 24-hour window, and that WhatsApp cannot remove it", () => {
    expect(WHATSAPP.testMessage).toBe(
      "GoatCitadel sends a test message where your bot posts. WhatsApp delivers it only within 24 hours of that person's last message to your number, so have them message it first. WhatsApp can't remove it afterwards.",
    );
    expect(WHATSAPP.testMessage).not.toContain("removes it");
    // The other channels keep the line the key pages share.
    expect(TOKEN_CHANGE_CHANNELS.get("discord")!.testMessage).toBeUndefined();
    expect(TOKEN_CHANGE_CHANNELS.get("slack")!.testMessage).toBeUndefined();
  });

  describe("what is stored", () => {
    it("is the access token alone", () => {
      expect(WHATSAPP.secretValues({ botToken: ACCESS_TOKEN, appToken: "" })).toEqual({ accessToken: ACCESS_TOKEN });
      // Nothing else of the five details is asked for, so nothing else can be replaced.
      expect(WHATSAPP.secretValues({ botToken: ACCESS_TOKEN, appToken: "xapp-ignored" })).toEqual({
        accessToken: ACCESS_TOKEN,
      });
    });

    it("leaves out the blanks a paste brings along", () => {
      expect(WHATSAPP.secretValues({ botToken: `  ${ACCESS_TOKEN}\n`, appToken: "" })).toEqual({
        accessToken: ACCESS_TOKEN,
      });
    });

    it("is nothing while the token is empty", () => {
      expect(WHATSAPP.secretValues({ botToken: "", appToken: "" })).toBeNull();
      expect(WHATSAPP.secretValues({ botToken: " \n ", appToken: "" })).toBeNull();
    });
  });

  describe("a check", () => {
    it("asks Meta about the stored token at the version it was given, and names the number", async () => {
      const outcome = await WHATSAPP.check(REF);

      expect(api.checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith({ ...REF, askMeta: true });
      expect(outcome).toEqual({
        kind: "checked",
        checked: {
          botId: PHONE_NUMBER_ID,
          botName: "Goat Shop",
          works: "Token works for +1 555-078-3881 (Goat Shop).",
        },
        // The draft already holds the number it follows, so there is nothing to keep on it.
        draftValues: {},
      });
    });

    it("reads the number the draft follows from the draft, not from Meta's answer", async () => {
      api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({ phoneNumberId: ` ${PHONE_NUMBER_ID}\n` }));
      const outcome = await WHATSAPP.check(REF);
      expect(api.fetchChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("rotate-1");
      expect(outcome).toMatchObject({ kind: "checked", checked: { botId: PHONE_NUMBER_ID } });
    });

    it("does not note when the token stops working: a token that expires is saved without a note here", async () => {
      api.checkWhatsAppSetup.mockResolvedValue(found({ tokenExpiresAt: "2026-10-29T18:00:00.000Z" }));
      const outcome = await WHATSAPP.check(REF);
      expect(outcome).toMatchObject({ kind: "checked", draftValues: {} });
      expect(JSON.stringify(outcome)).not.toContain("2026-10-29T18");
      expect(outcome.kind === "checked" && outcome.checked.inTheWay).toBeUndefined();
    });

    it("asks nothing of the app's subscription or the web address", async () => {
      await WHATSAPP.check(REF);
      const [input] = api.checkWhatsAppSetup.mock.calls[0] as [Record<string, unknown>];
      expect(Object.keys(input).sort()).toEqual(["askMeta", "draftId", "expectedRevision"]);
    });

    it("throws the one sentence a failed check comes to, never the error it had", async () => {
      api.checkWhatsAppSetup.mockRejectedValue(
        Object.assign(new Error(`GET /v23.0/${PHONE_NUMBER_ID} with Bearer ${ACCESS_TOKEN} failed`), {
          body: { error: `Bearer ${ACCESS_TOKEN}.` },
          cause: new Error(ACCESS_TOKEN),
        }),
      );
      const error = await failure(WHATSAPP.check(REF));
      expect(error.message).toBe(WHATSAPP.failed);
      expect(error.cause).toBeUndefined();
      expect([error.message, error.stack ?? "", JSON.stringify(error)].join("\n")).not.toContain(ACCESS_TOKEN);
    });

    it("throws that sentence when Meta gave no number, and reads no draft", async () => {
      api.checkWhatsAppSetup.mockResolvedValue({ appSubscribed: true });
      expect((await failure(WHATSAPP.check(REF))).message).toBe(WHATSAPP.failed);
      expect(api.fetchChannelSetupDraft).not.toHaveBeenCalled();
    });

    it.each([
      ["cannot be read", () => api.fetchChannelSetupDraft.mockRejectedValue(new Error(`offline ${ACCESS_TOKEN}`))],
      ["holds no number", () => api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({}))],
      ["holds a blank number", () => api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({ phoneNumberId: " " }))],
      [
        "holds a number that is not text",
        () => api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({ phoneNumberId: 106540352242922 })),
      ],
    ])(
      "throws that sentence when the draft %s: which number the token is for cannot be said",
      async (_name, arrange) => {
        arrange();
        const error = await failure(WHATSAPP.check(REF));
        expect(error.message).toBe(WHATSAPP.failed);
        expect(error.message).not.toContain(ACCESS_TOKEN);
      },
    );
  });
});
