import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  setChannelSetupDraftSecrets,
  updateChannelSetupDraft,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost as createHost } from "./channel-setup-service.test-support.js";

/**
 * A new connection keeps its draft's id, so a webhook channel's address (which holds the connection id) is known
 * before Finalize. These tests pin what that must not disturb: the draft and the connection share one id but not one
 * namespace, a draft is finalized once, and a change to a saved connection keeps the saved connection's own id.
 */
const CATALOG_ID = "channel.nextcloud-talk";
const SECRET = "synthetic-nextcloud-bot-secret-0123456789abcdef";
const SAVED_CONFIG = {
  baseUrl: "https://cloud.example.com",
  tokenEnv: "NEXTCLOUD_TALK_TOKEN",
  defaultRoomId: "a1b2c3d4",
};

type Host = ReturnType<typeof createHost>;

/** A new Nextcloud Talk draft that is ready to finalize, with its bot secret in secure custody. */
async function readyNewDraft(host: Host) {
  const created = await createChannelSetupDraft(host, { catalogId: CATALOG_ID, lifecycleMode: "create" });
  const configured = await updateChannelSetupDraft(host, created.draftId, {
    expectedRevision: created.revision,
    draft: { baseUrl: SAVED_CONFIG.baseUrl, defaultRoomId: SAVED_CONFIG.defaultRoomId },
  });
  const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
    expectedRevision: configured.revision,
    values: { token: SECRET },
  });
  return { created, secured };
}

describe("a new connection keeps its draft's id: the two are not one namespace", () => {
  it("has a draft id the webhook routes accept as a connection id", async () => {
    const host = createHost();
    const { created } = await readyNewDraft(host);

    // Every webhook route checks `:connectionId` with `z.guid()` (webhook-handler-factory.ts) before it looks the connection up.
    expect(z.guid().safeParse(created.draftId).success).toBe(true);
    expect(encodeURIComponent(created.draftId)).toBe(created.draftId);
  });

  it("has no connection under the draft's id until Finalize, and no draft under it after", async () => {
    const host = createHost();
    const { created, secured } = await readyNewDraft(host);

    await expect(host.getIntegrationConnection(created.draftId)).rejects.toThrow(/Unknown connection/);

    const result = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);

    expect(result.connection.connectionId).toBe(created.draftId);
    expect(await host.getIntegrationConnection(created.draftId)).toEqual(result.connection);
    expect(() => host.storage.channelSetupDrafts.get(created.draftId)).toThrow(/Missing draft/);
    expect(host.storage.channelSetupDrafts.listByConnection(created.draftId, 10)).toEqual([]);
  });

  it("moves the secret from the draft's custody into the connection's, under different owners of the same id", async () => {
    const host = createHost();
    const custody = host.channelSecrets!;
    const { created, secured } = await readyNewDraft(host);
    const temporaryRef = secured.secretState.token!.secretRef!;
    expect(temporaryRef).toMatch(new RegExp(`^keychain:goatcitadel:channel-draft:${created.draftId}:token:`, "u"));

    const result = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);

    const connectionRef = result.connection.config.token as string;
    expect(connectionRef).toMatch(
      new RegExp(`^keychain:goatcitadel:channel-connection:${created.draftId}:token:`, "u"),
    );
    expect(custody.resolve(connectionRef)).toBe(SECRET);
    expect(() => custody.resolve(temporaryRef)).toThrow(/unavailable/);
  });

  it("does not let a draft use a connection's saved key because their ids are equal", async () => {
    const host = createHost();
    const custody = host.channelSecrets!;
    const { created, secured } = await readyNewDraft(host);
    const result = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);
    const connectionRef = result.connection.config.token as string;

    // A draft with no connection (a new setup) owns no connection key, whatever its id is.
    expect(() => custody.assertUsableForDraft(connectionRef, { draftId: created.draftId, fieldKey: "token" })).toThrow(
      /belongs to a different connection/,
    );
    // A change to the new connection is its own draft, with its own id, and may use the connection's key.
    expect(() =>
      custody.assertUsableForDraft(connectionRef, {
        draftId: "a-later-edit-draft",
        connectionId: created.draftId,
        fieldKey: "token",
      }),
    ).not.toThrow();
    // Naming the connection id does not let a draft borrow another draft's temporary key.
    const otherDraftRef = custody.storeTemporary("another-draft", "token", "synthetic-other-secret");
    expect(() =>
      custody.assertUsableForDraft(otherDraftRef, {
        draftId: created.draftId,
        connectionId: created.draftId,
        fieldKey: "token",
      }),
    ).toThrow(/belongs to a different draft/);
  });
});

describe("finalizing a draft twice", () => {
  it("creates no second connection and overwrites none", async () => {
    const host = createHost();
    const { created, secured } = await readyNewDraft(host);
    const first = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);

    await expect(finalizeChannelSetupDraft(host, created.draftId, secured.revision)).rejects.toThrow(/Missing draft/);

    expect(host.createConnectionMock).toHaveBeenCalledTimes(1);
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
    expect(await host.getIntegrationConnection(created.draftId)).toEqual(first.connection);
  });

  it("lets one of two Finalize clicks through when they arrive together", async () => {
    const host = createHost();
    const { created, secured } = await readyNewDraft(host);

    const settled = await Promise.allSettled([
      finalizeChannelSetupDraft(host, created.draftId, secured.revision),
      finalizeChannelSetupDraft(host, created.draftId, secured.revision),
    ]);

    expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(host.createConnectionMock).toHaveBeenCalledTimes(1);
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
  });
});

describe("finalizing a change to a saved connection", () => {
  it.each(["edit", "repair"] as const)(
    "keeps the saved connection's own id in %s mode, never the change's draft id",
    async (lifecycleMode) => {
      const host = createHost();
      const saved = host.createConnectionMock({
        catalogId: CATALOG_ID,
        label: "Nextcloud Talk",
        enabled: true,
        status: "connected",
        config: SAVED_CONFIG,
      });
      const change = await createChannelSetupDraft(host, {
        catalogId: CATALOG_ID,
        connectionId: saved.connectionId,
        lifecycleMode,
      });
      expect(change.draftId).not.toBe(saved.connectionId);
      expect(change.connectionId).toBe(saved.connectionId);

      const result = await finalizeChannelSetupDraft(host, change.draftId, change.revision);

      expect(result.connection.connectionId).toBe(saved.connectionId);
      expect(result.connection.connectionId).not.toBe(change.draftId);
      // The saved connection was updated in place: one creation (the saved one), one update, no second connection.
      expect(host.createConnectionMock).toHaveBeenCalledTimes(1);
      expect(host.updateConnectionMock).toHaveBeenCalledOnce();
      expect(host.updateConnectionMock.mock.calls[0]?.[0]).toBe(saved.connectionId);
      await expect(host.getIntegrationConnection(change.draftId)).rejects.toThrow(/Unknown connection/);
    },
  );
});
