import { describe, expect, it } from "vitest";
import { ValidationError, type ChannelSetupDraft } from "@goatcitadel/contracts";
import { CHANNEL_SLACK_OAUTH_METADATA_KEYS, protectChannelOAuthDraftMetadata } from "./channel-oauth-draft-metadata.js";

function draft(values: Record<string, unknown> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 3,
    catalogId: "channel.slack",
    lifecycleMode: "edit",
    enabled: true,
    draft: values,
    secretState: {},
    contentVersion: "1",
    adapterVersion: "1",
    validationVersion: "1",
    testVersion: "1",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
}
const receipt = {
  authMode: "oauth",
  slackInstallId: "slack:T1:A1",
  slackTeamId: "T1",
  slackTeamName: "Sandbox",
  slackAppId: "A1",
  slackBotUserId: "B1",
  slackScopes: "chat:write",
  slackInstallerUserId: "U1",
  oauthConnectedAt: "2026-10-08T00:00:00.000Z",
};

describe("public channel draft OAuth metadata ownership", () => {
  it.each(CHANNEL_SLACK_OAUTH_METADATA_KEYS)("rejects a forged %s in a new Slack draft", (key) => {
    const current = draft();
    expect(() =>
      protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { [key]: receipt[key] } }),
    ).toThrow(ValidationError);
    expect(current.draft).toEqual({});
  });
  it.each(CHANNEL_SLACK_OAUTH_METADATA_KEYS)("rejects changing or clearing adopted %s", (key) => {
    const current = draft({ ...receipt });
    for (const value of ["forged", null, "", undefined, {}]) {
      expect(() => protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { [key]: value } })).toThrow(
        /explicitly adopt the bound installation/,
      );
    }
    expect(current.draft).toEqual(receipt);
  });
  it("preserves omitted adopted fields and accepts an unchanged public receipt with target edits", () => {
    const current = draft({ ...receipt, targets: [{ name: "Old", channel: "C1" }] });
    const nextTargets = [{ name: "Next", channel: "C2", default: true }];
    expect(
      protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { targets: nextTargets } }).draft,
    ).toEqual({ ...receipt, targets: nextTargets });
    expect(
      protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { ...receipt, targets: nextTargets } })
        .draft,
    ).toEqual({ ...receipt, targets: nextTargets });
    expect(current.draft.targets).toEqual([{ name: "Old", channel: "C1" }]);
  });
  it("retains inherited installation metadata when replacing a legacy draft's public fields", () => {
    const current = draft({ targets: [] });
    current.hydration = { status: "clean", fieldState: {}, warnings: [], rawLegacyConfig: { ...receipt } };
    expect(protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { targets: [] } }).draft).toEqual({
      ...receipt,
      targets: [],
    });
    expect(() =>
      protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: { slackAppId: "A2" } }),
    ).toThrow(ValidationError);
  });
  it("prefers newly adopted metadata over an earlier inherited receipt", () => {
    const current = draft({ ...receipt, slackTeamName: "Renamed" });
    current.hydration = { status: "clean", fieldState: {}, warnings: [], rawLegacyConfig: { ...receipt } };
    expect(protectChannelOAuthDraftMetadata(current, { expectedRevision: 3, draft: {} }).draft?.slackTeamName).toBe(
      "Renamed",
    );
  });
  describe("the Slack setup page in Chat, which makes a create draft and never adopts an installation", () => {
    const created = (values: Record<string, unknown> = {}): ChannelSetupDraft => ({
      ...draft(values),
      lifecycleMode: "create",
    });
    const dmRow = {
      id: "slack:D777",
      label: "Ada Lovelace",
      channel: "D777",
      kind: "private",
      source: "recent_update",
      setupCodeMatched: true,
      default: true,
    };
    const channelRow = {
      id: "slack:C100",
      label: "#general",
      channel: "C100",
      kind: "channel",
      source: "connection_config",
      default: true,
    };

    it("passes the token check's write through unchanged: the page mark and socket mode", () => {
      const current = created({ label: "kept" });
      const input = { expectedRevision: 3, draft: { label: "kept", setupPage: "messaging", receiveMode: "socket" } };
      const result = protectChannelOAuthDraftMetadata(current, input);
      expect(result.draft).toEqual(input.draft);
      expect(result.expectedRevision).toBe(3);
    });

    it("passes the code, the hi and a chosen channel through unchanged, each spread on the one before", () => {
      const checked = { setupPage: "messaging", receiveMode: "socket" };
      const withCode = { ...checked, setupCode: "Kp4mWz9RtX" };
      const withHi = {
        ...withCode,
        allowedSenders: ["U777"],
        ownerActorIds: ["U777"],
        inboundAccessMode: "allowlist",
        targets: [dmRow],
      };
      const inChannel = { ...withHi, targets: [{ ...dmRow, default: false }, channelRow] };
      for (const [before, after] of [
        [checked, withCode],
        [withCode, withHi],
        [withHi, inChannel],
      ]) {
        const result = protectChannelOAuthDraftMetadata(created(before), { expectedRevision: 3, draft: after });
        expect(result.draft).toEqual(after);
      }
    });

    it("adds no installation key of its own to a page-made draft", () => {
      const result = protectChannelOAuthDraftMetadata(created(), {
        expectedRevision: 3,
        draft: { setupPage: "messaging", receiveMode: "socket", allowedSenders: ["U777"] },
      });
      for (const key of CHANNEL_SLACK_OAUTH_METADATA_KEYS) expect(result.draft).not.toHaveProperty(key);
    });

    it("still refuses the identity the page used to write, which is why it no longer does", () => {
      const current = created();
      expect(() =>
        protectChannelOAuthDraftMetadata(current, {
          expectedRevision: 3,
          draft: { setupPage: "messaging", receiveMode: "socket", slackTeamId: "T1", slackTeamName: "Goat Team" },
        }),
      ).toThrow(/explicitly adopt the bound installation/);
    });
  });

  it("does not invent an OAuth receipt for manual Slack setup or change unrelated catalogs", () => {
    const input = { expectedRevision: 3, label: "Manual", draft: { targets: [], defaultChannel: "C1" } };
    expect(protectChannelOAuthDraftMetadata(draft(), input)).toEqual(input);
    const nonSlack = { ...draft(), catalogId: "channel.telegram" };
    const otherInput = { expectedRevision: 3, draft: { slackInstallId: "custom-value" } };
    expect(protectChannelOAuthDraftMetadata(nonSlack, otherInput)).toBe(otherInput);
    const noFields = { expectedRevision: 3, enabled: false };
    expect(protectChannelOAuthDraftMetadata(draft(receipt), noFields)).toBe(noFields);
  });
});
