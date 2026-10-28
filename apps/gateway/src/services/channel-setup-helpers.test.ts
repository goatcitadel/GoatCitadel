import { describe, expect, it } from "vitest";
import { listChannelSetupDefinitions, requireChannelSetupDefinition } from "./channel-setup-definitions.js";
import { guideFinish } from "./channel-setup-definitions/guide-finish.test-support.js";
import { buildEphemeralChannelConnection, clearedChannelConfigKeys } from "./channel-setup-helpers.js";

const REVISION = "a".repeat(64);
const SAVED_TOKEN_REF = "keychain:goatcitadel:channel-connection:11111111-1111-1111-1111-111111111111:botToken:0001";

describe("clearedChannelConfigKeys", () => {
  it("lists only the keys a guide set to null, not keys it left out, left empty or set to a falsy value", () => {
    expect([
      ...clearedChannelConfigKeys({ cleared: null, left: undefined, empty: "", zero: 0, off: false, kept: "value" }),
    ]).toEqual(["cleared"]);
  });
});

describe("a guide's normalize that never clears a key", () => {
  it("is the case for every guide but Google Chat, so null clearing changes nothing else", () => {
    const clearing = listChannelSetupDefinitions()
      .filter((definition) => {
        const { draftOf } = guideFinish(definition.catalog.catalogId);
        const normalized = requireChannelSetupDefinition(definition.catalog.catalogId).normalize(draftOf({}));
        return clearedChannelConfigKeys(normalized).size > 0;
      })
      .map((definition) => definition.catalog.key);

    expect(clearing).toEqual(["google-chat"]);
  });
});

describe("buildEphemeralChannelConnection: another guide's edit", () => {
  const { draftOf, connectionOf } = guideFinish("channel.telegram");

  async function editedTelegram(saved: Record<string, unknown>, chosen: Record<string, unknown>) {
    const connection = { ...connectionOf(saved), revision: REVISION };
    const draft = draftOf(chosen, { connectionId: connection.connectionId, connectionRevision: REVISION }, "edit");
    return (await buildEphemeralChannelConnection({ getIntegrationConnection: async () => connection }, draft)).config;
  }

  it("keeps the saved secret reference it does not replace, and the other settings it does not change", async () => {
    const config = await editedTelegram(
      { botToken: SAVED_TOKEN_REF, defaultChatId: "123", inboundAccessMode: "allowlist", allowedSenders: ["456"] },
      { defaultChatId: "789" },
    );

    expect(config).toMatchObject({
      botToken: SAVED_TOKEN_REF,
      defaultChatId: "789",
      inboundAccessMode: "allowlist",
      allowedSenders: ["456"],
    });
  });
});
