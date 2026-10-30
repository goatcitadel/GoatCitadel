import { describe, expect, it } from "vitest";
import type { ChannelSetupFieldDefinition, ChannelSetupStepDefinition } from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { guideFinish } from "./guide-finish.test-support.js";
import { GUIDED_CONTENT_VERSION_SUFFIX } from "./guided-journey.js";
import { CHANNEL_PICKER_HINTS } from "./picker-hints.js";

const { draftOf, connectionOf } = guideFinish("channel.whatsapp");

function guide() {
  return requireChannelSetupDefinition("channel.whatsapp");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`WhatsApp guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`WhatsApp guide has no field ${key}`);
  return found;
}

const SEND_ONLY_VALUES = {
  accessToken: "secret-reference",
  phoneNumberId: "123456789012345",
  defaultTarget: "15551234567",
};

describe("WhatsApp setup keeps the app and account IDs and who made the setup", () => {
  it("keeps the app and account IDs and who made the setup", () => {
    const config = guide().normalize(
      draftOf({
        ...SEND_ONLY_VALUES,
        appId: "1234567",
        businessAccountId: "7654321",
        ownerActorIds: ["15551234567"],
      }),
    );

    expect(config.appId).toBe("1234567");
    expect(config.businessAccountId).toBe("7654321");
    expect(config.ownerActorIds).toEqual(["15551234567"]);

    const hydrated = guide().hydrate(
      connectionOf({
        phoneNumberId: "123456789012345",
        defaultTarget: "15551234567",
        appId: "1234567",
        businessAccountId: "7654321",
        ownerActorIds: ["15551234567"],
      }),
    );
    expect(hydrated.draft.appId).toBe("1234567");
    expect(hydrated.draft.businessAccountId).toBe("7654321");
    expect(hydrated.draft.ownerActorIds).toEqual(["15551234567"]);
    expect(hydrated.hydration.fieldState.appId).toBe("configured");
    expect(hydrated.hydration.fieldState.businessAccountId).toBe("configured");
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("configured");

    // Editing a saved connection carries all three through the draft and back into the config.
    const edited = guide().normalize(draftOf({ ...hydrated.draft, accessToken: "secret-reference" }));
    expect(edited.appId).toBe("1234567");
    expect(edited.businessAccountId).toBe("7654321");
    expect(edited.ownerActorIds).toEqual(["15551234567"]);
  });

  it("cleans the values the way the runtime reads them", () => {
    const config = guide().normalize(
      draftOf({
        ...SEND_ONLY_VALUES,
        appId: " 1234567 ",
        businessAccountId: " 7654321 ",
        ownerActorIds: [" 15551234567 ", "15551234567", "", 7],
      }),
    );

    expect(config.appId).toBe("1234567");
    expect(config.businessAccountId).toBe("7654321");
    expect(config.ownerActorIds).toEqual(["15551234567"]);
  });

  it("leaves them out when the draft or the saved connection has none", () => {
    const config = guide().normalize(draftOf(SEND_ONLY_VALUES));
    // A key left out keeps the saved connection's own value on edit.
    expect(config).not.toHaveProperty("appId");
    expect(config).not.toHaveProperty("businessAccountId");
    expect(config).not.toHaveProperty("ownerActorIds");

    const emptied = guide().normalize(
      draftOf({ ...SEND_ONLY_VALUES, appId: "  ", businessAccountId: "", ownerActorIds: [] }),
    );
    expect(emptied).not.toHaveProperty("appId");
    expect(emptied).not.toHaveProperty("businessAccountId");
    expect(emptied).not.toHaveProperty("ownerActorIds");

    const hydrated = guide().hydrate(connectionOf({ phoneNumberId: "123456789012345", defaultTarget: "15551234567" }));
    expect(hydrated.draft).not.toHaveProperty("appId");
    expect(hydrated.draft).not.toHaveProperty("businessAccountId");
    expect(hydrated.draft).not.toHaveProperty("ownerActorIds");
    expect(hydrated.hydration.fieldState.appId).toBe("unknown");
    expect(hydrated.hydration.fieldState.businessAccountId).toBe("unknown");
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("unknown");
  });
});

describe("WhatsApp setup asks for the app and account IDs", () => {
  it("asks for them in the receive step, after the app secret, as optional numbers", () => {
    const keys = (step("receive-messages").fields ?? []).map((candidate) => candidate.key);

    expect(keys.indexOf("appId")).toBeGreaterThan(keys.indexOf("appSecret"));
    expect(keys.indexOf("businessAccountId")).toBeGreaterThan(keys.indexOf("appId"));
    expect(field("appId").label).toBe("App ID");
    expect(field("businessAccountId").label).toBe("WhatsApp Business Account ID");
    for (const key of ["appId", "businessAccountId"]) {
      expect(field(key).inputMode, key).toBe("numeric");
      expect(field(key).required, key).not.toBe(true);
      expect(field(key).sensitive, key).not.toBe(true);
    }
  });

  it("does not list either one as a secret", () => {
    expect(guide().definition.adapter.secretFieldKeys).toEqual(["accessToken", "appSecret", "webhookVerifyToken"]);
  });
});

describe("WhatsApp setup checks the IDs' shape", () => {
  it("checks the IDs' shape", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, appId: "abc", businessAccountId: "x" }));

    expect(issues).toEqual([
      expect.objectContaining({
        fieldKey: "appId",
        level: "error",
        message: "Use the App ID from your Meta app's Basic settings: digits only.",
        failureCategory: "malformed_value",
      }),
      expect.objectContaining({
        fieldKey: "businessAccountId",
        level: "error",
        message: "Use the WhatsApp Business Account ID from API Setup: digits only.",
        failureCategory: "malformed_value",
      }),
    ]);
  });

  it("accepts digits, and accepts both left empty", () => {
    expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, appId: "1234567", businessAccountId: "7654321" }))).toEqual(
      [],
    );
    expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, appId: " 1234567 " }))).toEqual([]);
    expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, appId: "", businessAccountId: "  " }))).toEqual([]);
    expect(guide().validate(draftOf(SEND_ONLY_VALUES))).toEqual([]);
  });

  it("wants at least six digits, as the phone number ID does", () => {
    const issues = guide().validate(draftOf({ ...SEND_ONLY_VALUES, appId: "12345", businessAccountId: "123456" }));

    expect(issues.map((issue) => issue.fieldKey)).toEqual(["appId"]);
  });

  it("never repeats what was typed in the message", () => {
    const issues = guide().validate(
      draftOf({ ...SEND_ONLY_VALUES, appId: "app-secret-typed-by-mistake", businessAccountId: "token-typed" }),
    );

    expect(issues.length).toBe(2);
    expect(JSON.stringify(issues)).not.toMatch(/typed/u);
  });

  it("accepts a WhatsApp ID as the default contact", () => {
    expect(guide().validate(draftOf({ ...SEND_ONLY_VALUES, defaultTarget: "15551234567" }))).toEqual([]);
  });
});

describe("WhatsApp setup tells the setup story up front", () => {
  it("tells the setup story up front", () => {
    expect(guide().definition.wizard.introSummary).toBe(
      "Send and receive WhatsApp messages through your own Meta app. Meta delivers messages only to a public https:// address, so GoatCitadel needs one. The quickest setup is WhatsApp in Chat › Messaging.",
    );
  });

  it("shows WhatsApp in the picker as a fifteen-minute job", () => {
    expect(CHANNEL_PICKER_HINTS.whatsapp).toEqual({
      group: "phone_apps",
      note: "Business account + public web address",
      minutes: 15,
    });
    expect(guide().definition.wizard.picker).toEqual({
      group: "phone_apps",
      note: "Business account + public web address",
      minutes: 15,
      order: 0,
    });
  });

  it("carries a new guide-text version, so setup tests that passed on the old text run again", () => {
    // Setup evidence records this version. The summary and the fields changed, so the shared suffix moved on.
    expect(GUIDED_CONTENT_VERSION_SUFFIX).not.toBe(".guided-2026-10-29");
    expect(GUIDED_CONTENT_VERSION_SUFFIX).toBe(".guided-2026-10-29-whatsapp");
    expect(guide().definition.wizard.contentVersion).toBe(`2026.08.whatsapp.v3${GUIDED_CONTENT_VERSION_SUFFIX}`);
  });
});
