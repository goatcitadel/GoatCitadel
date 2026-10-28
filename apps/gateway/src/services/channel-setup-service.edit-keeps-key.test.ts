import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupIssue } from "@goatcitadel/contracts";
import { resolveConnectionConfigSecret } from "./channel-secret-resolution.js";
import {
  createChannelSetupDraft,
  finalizeChannelSetupDraft,
  retestChannelConnection,
  setChannelSetupDraftSecrets,
  testChannelSetupDraft,
  updateChannelSetupDraft,
  validateChannelSetupDraft,
} from "./channel-setup-service.js";
import { createChannelSetupTestHost as createHost } from "./channel-setup-service.test-support.js";
import { guideFinish } from "./channel-setup-definitions/guide-finish.test-support.js";
import {
  buildIntegrationConnectionChecks,
  runIntegrationConnectionLiveChecks,
} from "./integration-diagnostics-service.js";

/**
 * Changing a saved channel without touching its key must keep the key. A pasted key is saved in secure storage and the
 * connection holds only a reference to it, so an edit that leaves the key alone has to carry that reference through
 * Validate, the live test and Finalize: no "paste it again", the test reads the saved key, and the connection ends up
 * with the same reference to the same entry.
 *
 * The saved connection is made the way a real setup makes one (create draft, pasted key, Finalize), over the real
 * secure-storage service, so the reference it holds is a real one. The live test is the real set of channel checks over
 * a fake network that notes whether each request carried the key.
 */

type Host = ReturnType<typeof createHost>;

interface EditCase {
  readonly name: string;
  readonly catalogId: string;
  /** The pasted field that holds the key, and the key. */
  readonly secretField: string;
  readonly secret: string;
  /** The settings the setup is created with (everything but the key). */
  readonly created: Record<string, unknown>;
  /** The one non-secret setting the edit changes, and the saved config key that shows it. */
  readonly change: Record<string, unknown>;
  readonly changedConfig: Record<string, unknown>;
}

const CASES: readonly EditCase[] = [
  {
    name: "Telegram (bot token)",
    catalogId: "channel.telegram",
    secretField: "botToken",
    secret: "123456789:synthetic-edit-keeps-key-token",
    created: { targets: [{ id: "ops", label: "Ops", chatId: "-1001111111111", default: true }] },
    change: { targets: [{ id: "ops", label: "Ops", chatId: "-1002222222222", default: true }] },
    changedConfig: { defaultChatId: "-1002222222222" },
  },
  {
    name: "Slack (bot token)",
    catalogId: "channel.slack",
    secretField: "botToken",
    secret: "xoxb-123-456-synthetic-edit-keeps-key",
    created: { targets: [{ id: "ops", label: "Ops", channel: "C0111111111", default: true }] },
    change: { targets: [{ id: "ops", label: "Ops", channel: "C0222222222", default: true }] },
    changedConfig: { defaultChannel: "C0222222222" },
  },
  {
    name: "Google Chat, incoming webhook (the address is the key)",
    catalogId: "channel.google-chat",
    secretField: "webhookUrl",
    secret: "https://chat.googleapis.com/v1/spaces/AAAAxxxx/messages?key=synthetic-key&token=synthetic-edit-keeps-key",
    created: { mode: "webhook", defaultThreadKey: "ops" },
    change: { defaultThreadKey: "ops-two" },
    changedConfig: { defaultThreadKey: "ops-two" },
  },
  {
    name: "Slack, incoming webhook (the address is the key)",
    catalogId: "channel.slack",
    secretField: "webhookUrl",
    secret: "https://hooks.slack.com/services/T0000/B0000/synthetic-edit-keeps-key",
    created: {},
    change: { targets: [{ id: "ops", label: "Ops", channel: "C0222222222", default: true }] },
    changedConfig: { defaultChannel: "C0222222222" },
  },
  {
    name: "Discord, webhook (the address is the key)",
    catalogId: "channel.discord",
    secretField: "webhookUrl",
    secret: "https://discord.com/api/webhooks/123456789012345678/synthetic-edit-keeps-key",
    created: { runtimeMode: "bridge", defaultChannelId: "123456789012345678" },
    change: { defaultChannelId: "223456789012345678" },
    changedConfig: { defaultChannelId: "223456789012345678" },
  },
  {
    name: "Teams, Workflows webhook (the address is the key)",
    catalogId: "channel.teams",
    secretField: "webhookUrl",
    secret:
      "https://defaultenvironment.00.environment.api.powerplatform.com/powerautomate/automations/direct/cu/20/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=synthetic-edit-keeps-key",
    created: { cardTitle: "Ops" },
    change: { cardTitle: "Ops team" },
    changedConfig: { cardTitle: "Ops team" },
  },
  {
    name: "Google Chat, Chat app (service-account key)",
    catalogId: "channel.google-chat",
    secretField: "serviceAccountKey",
    secret: JSON.stringify({
      client_email: "bot@example.iam.gserviceaccount.com",
      private_key: "synthetic-edit-keeps",
    }),
    created: {
      mode: "app",
      audienceType: "project_number",
      audience: "123456789012",
      defaultSpace: "spaces/AAAA",
      allowedSenders: ["users/1"],
    },
    change: { defaultSpace: "spaces/BBBB" },
    changedConfig: { defaultSpace: "spaces/BBBB" },
  },
];

/** What the fake network was asked, as booleans only: the key itself is never kept. */
interface NetworkNotes {
  requests: number;
  withKey: number;
}

/**
 * Wires the host's checks the way the Gateway does: the real channel checks, reading a saved key through the shared
 * read (`resolveConnectionConfigSecret`) for the connection under test, over the host's own secure storage.
 */
function useRealChecks(host: Host, testCase: EditCase): NetworkNotes {
  const notes: NetworkNotes = { requests: 0, withKey: 0 };
  const custody = host.channelSecrets!;
  const storedKeys = {
    getSecret: (account: string) => {
      try {
        return custody.resolve(`keychain:goatcitadel:${account}`);
      } catch {
        return undefined;
      }
    },
  };
  const carriesKey = (url: string, init?: RequestInit) =>
    `${url} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? "")}`.includes(testCase.secret) ||
    // A webhook address is the key; the request goes to it.
    url === testCase.secret;
  const fake = guideFinish(testCase.catalogId, {
    fetch: async (url, init) => {
      notes.requests += 1;
      if (carriesKey(url, init)) notes.withKey += 1;
      return new Response(JSON.stringify({ ok: true, ts: "1.2", result: { message_id: 7 } }), { status: 200 });
    },
  }).port();
  const port = {
    ...fake,
    resolveConnectionSecret: (
      config: Record<string, unknown>,
      directKey: string,
      envKey: string,
      catalogId: string | undefined,
      owner: { connectionId: string; draftId?: string },
    ) => resolveConnectionConfigSecret(storedKeys, config, directKey, envKey, catalogId, owner),
  } as typeof fake;
  // The shared read the Gateway hands the setup service (`GatewayService.resolveConnectionSecret`).
  host.resolveConnectionSecret = port.resolveConnectionSecret as NonNullable<Host["resolveConnectionSecret"]>;
  host.runIntegrationConnectionLiveChecks = vi.fn(async (connection, options) =>
    runIntegrationConnectionLiveChecks(port, connection, options),
  );
  host.buildIntegrationConnectionChecks = vi.fn((connection) => buildIntegrationConnectionChecks(port, connection));
  return notes;
}

/** A saved connection made the way a real setup makes one: create, paste the key, Finalize. */
async function saveWithPastedKey(host: Host, testCase: EditCase) {
  const created = await createChannelSetupDraft(host, { catalogId: testCase.catalogId, lifecycleMode: "create" });
  const configured = await updateChannelSetupDraft(host, created.draftId, {
    expectedRevision: created.revision,
    label: testCase.name,
    draft: testCase.created,
  });
  const secured = await setChannelSetupDraftSecrets(host, created.draftId, {
    expectedRevision: configured.revision,
    values: { [testCase.secretField]: testCase.secret },
  });
  const result = await finalizeChannelSetupDraft(host, created.draftId, secured.revision);
  return result.connection;
}

/** The message of every error or warning, and the field each one names: all that the person is asked to do. */
function asked(issues: readonly ChannelSetupIssue[]): string[] {
  return issues.filter((issue) => issue.level !== "info").map((issue) => `${issue.key}: ${issue.message}`);
}

describe.each(CASES)("editing a saved channel and leaving its key alone: $name", (testCase) => {
  const setup = async () => {
    const host = createHost();
    const notes = useRealChecks(host, testCase);
    const saved = await saveWithPastedKey(host, testCase);
    const savedReference = saved.config[testCase.secretField];
    return { host, notes, saved, savedReference: savedReference as string };
  };

  it("saves the setup with a reference to the key, and nothing of the key itself", async () => {
    const { host, saved, savedReference } = await setup();

    expect(savedReference).toEqual(expect.stringMatching(/^keychain:goatcitadel:channel-connection:/u));
    expect(host.channelSecrets!.resolve(savedReference)).toBe(testCase.secret);
    expect(JSON.stringify(saved.config)).not.toContain(testCase.secret);
  });

  it("asks for no key at Validate, and carries no key in the edit draft", async () => {
    const { host, saved } = await setup();
    const edit = await createChannelSetupDraft(host, {
      catalogId: testCase.catalogId,
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });
    const changed = await updateChannelSetupDraft(host, edit.draftId, {
      expectedRevision: edit.revision,
      draft: { ...edit.draft, ...testCase.change },
    });

    const validation = await validateChannelSetupDraft(host, changed.draftId, changed.revision);

    expect(asked(validation.issues)).toEqual([]);
    expect(validation.status).toBe("ok");
    expect(JSON.stringify({ edit, changed, validation })).not.toContain(testCase.secret);
  });

  it("makes the live test read the saved key", async () => {
    const { host, notes, saved } = await setup();
    const requestsBefore = notes.requests;
    const withKeyBefore = notes.withKey;
    const edit = await createChannelSetupDraft(host, {
      catalogId: testCase.catalogId,
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });
    const changed = await updateChannelSetupDraft(host, edit.draftId, {
      expectedRevision: edit.revision,
      draft: { ...edit.draft, ...testCase.change },
    });

    const result = await testChannelSetupDraft(host, changed.draftId, changed.revision);

    // A Chat app is never sent a test message; every other case reaches its provider, and every request carries the key.
    if (testCase.secretField !== "serviceAccountKey") {
      expect(notes.requests).toBeGreaterThan(requestsBefore);
      expect(notes.withKey - withKeyBefore).toBe(notes.requests - requestsBefore);
    }
    expect(result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message)).toEqual([]);
    expect(result.finalizationEligibility).toMatchObject({ allowed: true, blockingReasons: [] });
    expect(JSON.stringify(result)).not.toContain(testCase.secret);
  });

  it("finalizes the change with the same reference, to the same entry in secure storage", async () => {
    const { host, saved, savedReference } = await setup();
    const accountsBefore = host.secretAccounts();
    const edit = await createChannelSetupDraft(host, {
      catalogId: testCase.catalogId,
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });
    const changed = await updateChannelSetupDraft(host, edit.draftId, {
      expectedRevision: edit.revision,
      draft: { ...edit.draft, ...testCase.change },
    });
    const tested = await testChannelSetupDraft(host, changed.draftId, changed.revision);

    const finalized = await finalizeChannelSetupDraft(host, changed.draftId, tested.draftRevision);

    expect(finalized.connection.connectionId).toBe(saved.connectionId);
    expect(finalized.connection.config).toMatchObject(testCase.changedConfig);
    expect(finalized.connection.config[testCase.secretField]).toBe(savedReference);
    expect(host.secretAccounts()).toEqual(accountsBefore);
    expect(host.channelSecrets!.resolve(savedReference)).toBe(testCase.secret);
    expect(JSON.stringify(finalized.connection.config)).not.toContain(testCase.secret);
  });

  it("lets the saved connection be retested without asking for its key, and changes nothing saved", async () => {
    const { host, notes, saved, savedReference } = await setup();
    const accountsBefore = host.secretAccounts();
    const requestsBefore = notes.requests;

    const result = await retestChannelConnection(host, saved.connectionId);

    if (testCase.secretField !== "serviceAccountKey") expect(notes.requests).toBeGreaterThan(requestsBefore);
    expect(result.issues.filter((issue) => issue.level === "error").map((issue) => issue.message)).toEqual([]);
    expect(result.finalizationEligibility).toMatchObject({ allowed: true });
    expect(host.updateConnectionMock).not.toHaveBeenCalled();
    expect((await host.getIntegrationConnection(saved.connectionId)).config[testCase.secretField]).toBe(savedReference);
    expect(host.secretAccounts()).toEqual(accountsBefore);
  });

  it("finalizes straight from the edit, without a separate test first, and still keeps the key", async () => {
    const { host, saved, savedReference } = await setup();
    const accountsBefore = host.secretAccounts();
    const edit = await createChannelSetupDraft(host, {
      catalogId: testCase.catalogId,
      connectionId: saved.connectionId,
      lifecycleMode: "edit",
    });
    const changed = await updateChannelSetupDraft(host, edit.draftId, {
      expectedRevision: edit.revision,
      draft: { ...edit.draft, ...testCase.change },
    });

    const finalized = await finalizeChannelSetupDraft(host, changed.draftId, changed.revision);

    expect(finalized.connection.config).toMatchObject(testCase.changedConfig);
    expect(finalized.connection.config[testCase.secretField]).toBe(savedReference);
    expect(host.secretAccounts()).toEqual(accountsBefore);
    expect(host.channelSecrets!.resolve(savedReference)).toBe(testCase.secret);
  });
});
