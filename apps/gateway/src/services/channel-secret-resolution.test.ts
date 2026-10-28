import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelSecretOwnerForDraft,
  createConnectionSecretReferenceResolver,
  isChannelSecretReferenceOwnedBy,
  readConfigSecret,
  resolveChannelSendEnvSecret,
  resolveConnectionConfigSecret,
  resolveTelegramWebhookSecret,
} from "./channel-secret-resolution.js";

const connectionId = "conn-1";
const ownReference = `keychain:goatcitadel:channel-connection:${connectionId}:webhookSecret:00000000-0000-4000-8000-000000000001`;
const otherReference =
  "keychain:goatcitadel:channel-connection:conn-2:webhookSecret:00000000-0000-4000-8000-000000000002";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createConnectionSecretReferenceResolver", () => {
  it("reads a key this connection saved and trims it", () => {
    const readReference = vi.fn(() => "  real-secret \n");

    expect(createConnectionSecretReferenceResolver(connectionId, readReference)(ownReference)).toBe("real-secret");
    // The reader is told whose key it reads, so it can hand that owner to the shared read.
    expect(readReference).toHaveBeenCalledWith(ownReference, { connectionId });
  });

  it("checks the owner on the trimmed reference and reads with the trimmed reference", () => {
    const readReference = vi.fn(() => "real-secret");

    expect(createConnectionSecretReferenceResolver(connectionId, readReference)(`  ${ownReference}\n`)).toBe(
      "real-secret",
    );
    expect(readReference).toHaveBeenCalledWith(ownReference, { connectionId });
  });

  it.each([
    ["another connection's reference", otherReference],
    [
      "a reference whose connection id only starts like this one",
      "keychain:goatcitadel:channel-connection:conn-10:webhookSecret:00000000-0000-4000-8000-000000000003",
    ],
    [
      "a setup draft reference",
      "keychain:goatcitadel:channel-draft:conn-1:webhookSecret:00000000-0000-4000-8000-000000000004",
    ],
    ["text that is not a reference", "plain-secret"],
  ])("never reads %s", (_label, secretRef) => {
    const readReference = vi.fn(() => "real-secret");

    expect(createConnectionSecretReferenceResolver(connectionId, readReference)(secretRef)).toBeUndefined();
    expect(readReference).not.toHaveBeenCalled();
  });

  it("gives no key when nothing is stored, the stored key is blank, or the read fails", () => {
    expect(createConnectionSecretReferenceResolver(connectionId, () => undefined)(ownReference)).toBeUndefined();
    expect(createConnectionSecretReferenceResolver(connectionId, () => "  ")(ownReference)).toBeUndefined();
    expect(
      createConnectionSecretReferenceResolver(connectionId, () => {
        throw new Error("keychain unavailable");
      })(ownReference),
    ).toBeUndefined();
  });

  it("gives no key when there is no reader", () => {
    expect(createConnectionSecretReferenceResolver(connectionId, undefined)(ownReference)).toBeUndefined();
  });
});

describe("readConfigSecret with a reference resolver", () => {
  it("returns the key a saved reference points to", () => {
    expect(readConfigSecret({ token: ownReference }, "token", "tokenEnv", () => "real-secret")).toBe("real-secret");
  });

  it("returns a direct secret that is not a reference as it is, without asking the resolver", () => {
    const resolveReference = vi.fn(() => "real-secret");

    expect(readConfigSecret({ token: " direct " }, "token", "tokenEnv", resolveReference)).toBe("direct");
    expect(resolveReference).not.toHaveBeenCalled();
  });

  it("never returns the reference text, and does not fall back to an env var when its key is missing", () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "env-telegram");

    expect(
      readConfigSecret(
        { token: ownReference, tokenEnv: "TELEGRAM_WEBHOOK_SECRET" },
        "token",
        "tokenEnv",
        () => undefined,
      ),
    ).toBeUndefined();
  });

  it("still reads an allowlisted env var when no direct value is saved", () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "env-telegram");

    expect(readConfigSecret({ tokenEnv: "TELEGRAM_WEBHOOK_SECRET" }, "token", "tokenEnv", () => "unused")).toBe(
      "env-telegram",
    );
  });

  it("returns direct values as saved when no resolver is given, as before", () => {
    expect(readConfigSecret({ token: ownReference }, "token", "tokenEnv")).toBe(ownReference);
  });
});

describe("resolveTelegramWebhookSecret with a reference resolver", () => {
  it("reads the key behind a saved webhook secret reference", () => {
    expect(resolveTelegramWebhookSecret({ webhookSecret: ownReference }, () => "real-secret")).toBe("real-secret");
  });

  it("is missing, never the reference text, when the saved key cannot be read", () => {
    expect(resolveTelegramWebhookSecret({ webhookSecret: ownReference }, () => undefined)).toBeUndefined();
  });

  it("keeps direct secrets working without a resolver", () => {
    expect(resolveTelegramWebhookSecret({ secretToken: "direct-telegram" })).toBe("direct-telegram");
  });
});

describe("resolveChannelSendEnvSecret", () => {
  const SECRET = "synthetic-send-env-value";

  it("reads a variable whose name the credential rule allows for the connection's catalog entry", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", `  ${SECRET} `);
    vi.stubEnv("INTEGRATION_MATTERMOST_TOKEN", "other-synthetic-value");

    expect(
      resolveChannelSendEnvSecret({
        catalogId: "channel.mattermost",
        channelKey: "mattermost",
        field: "botTokenEnv",
        envName: " MATTERMOST_BOT_TOKEN ",
      }),
    ).toEqual({ value: SECRET });
    expect(
      resolveChannelSendEnvSecret({
        catalogId: "channel.mattermost",
        channelKey: "mattermost",
        field: "botTokenEnv",
        envName: "INTEGRATION_MATTERMOST_TOKEN",
      }),
    ).toEqual({ value: "other-synthetic-value" });
  });

  it("gives neither a value nor a refusal when the allowed variable is not set or is blank", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "   ");

    for (const envName of ["MATTERMOST_BOT_TOKEN", "MATTERMOST_NOT_SET_ANYWHERE"]) {
      expect(
        resolveChannelSendEnvSecret({
          catalogId: "channel.mattermost",
          channelKey: "mattermost",
          field: "botTokenEnv",
          envName,
        }),
      ).toEqual({ value: undefined });
    }
  });

  it.each([
    ["an LLM provider key", "OPENAI_API_KEY"],
    ["a Gateway key", "GOATCITADEL_AUTH_TOKEN"],
    ["another channel's variable", "SLACK_BOT_TOKEN"],
    ["a database password", "POSTGRES_PASSWORD"],
    ["a cloud key", "AWS_SECRET_ACCESS_KEY"],
    ["a lowercase name", "mattermost_bot_token"],
    ["a token pasted into the name field", "xoxb-1234-pasted-token-not-a-name"],
  ])("refuses %s without reading it, and the sentence holds no name or value", (_label, envName) => {
    vi.stubEnv(envName, SECRET);

    const resolution = resolveChannelSendEnvSecret({
      catalogId: "channel.mattermost",
      channelKey: "mattermost",
      field: "botTokenEnv",
      envName,
    });

    expect(resolution).toEqual({
      refusal: "The variable name must start with MATTERMOST_. Rename it and restart GoatCitadel.",
    });
    expect(JSON.stringify(resolution)).not.toContain(SECRET);
    expect(JSON.stringify(resolution)).not.toContain(envName);
  });

  it("reads the SMTP password variable the mail form suggests, and refuses an LLM key for it", () => {
    vi.stubEnv("SMTP_PASSWORD", SECRET);
    vi.stubEnv("OPENAI_API_KEY", "other-synthetic-value");
    const mail = { catalogId: "automation.imap-smtp", channelKey: "imap-smtp", field: "smtpPasswordEnv" };

    expect(resolveChannelSendEnvSecret({ ...mail, envName: "SMTP_PASSWORD" })).toEqual({ value: SECRET });
    expect(resolveChannelSendEnvSecret({ ...mail, envName: "OPENAI_API_KEY" })).toEqual({
      refusal: "The variable name must start with SMTP_ or IMAP_. Rename it and restart GoatCitadel.",
    });
    // The mail prefixes belong to the mail connection only.
    expect(
      resolveChannelSendEnvSecret({
        catalogId: "channel.mattermost",
        channelKey: "mattermost",
        field: "botTokenEnv",
        envName: "SMTP_PASSWORD",
      }),
    ).toMatchObject({ refusal: expect.any(String) });
  });

  it("refuses every name when the connection has no catalog entry, and says so plainly", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", SECRET);

    for (const catalogId of [undefined, ""] as unknown as string[]) {
      expect(
        resolveChannelSendEnvSecret({
          catalogId,
          channelKey: "mattermost",
          field: "botTokenEnv",
          envName: "MATTERMOST_BOT_TOKEN",
        }),
      ).toEqual({
        refusal: "That variable name is not allowed for this connection. Rename it and restart GoatCitadel.",
      });
    }
  });
});

describe("isChannelSecretReferenceOwnedBy", () => {
  const owner = { connectionId };
  const draftReference = "keychain:goatcitadel:channel-draft:draft-1:token:00000000-0000-4000-8000-000000000005";

  it.each([
    ["this connection's own reference", ownReference],
    ["this connection's own reference with spaces around it", `  ${ownReference}\n`],
    ["an older own reference with no nonce", `keychain:goatcitadel:channel-connection:${connectionId}:webhookSecret`],
  ])("accepts %s", (_label, reference) => {
    expect(isChannelSecretReferenceOwnedBy(reference, owner)).toBe(true);
  });

  it.each([
    ["another connection's reference", otherReference],
    [
      "a reference whose connection id only starts like this one",
      "keychain:goatcitadel:channel-connection:conn-10:webhookSecret:00000000-0000-4000-8000-000000000003",
    ],
    ["a draft's reference, when the owner has no draft", draftReference],
    [
      "a draft reference whose draft id is this connection's id",
      "keychain:goatcitadel:channel-draft:conn-1:webhookSecret:00000000-0000-4000-8000-000000000004",
    ],
    ["an approval token reference", "keychain:goatcitadel:approval-remote-action:00000000-0000-4000-8000-000000000005"],
    ["a reference with no owner part", "keychain:goatcitadel:channel-connection:"],
    ["a reference with too many parts", `${ownReference}:extra:parts`],
    ["text that is not a reference", "plain-secret"],
    ["a blank value", "   "],
  ])("refuses %s", (_label, reference) => {
    expect(isChannelSecretReferenceOwnedBy(reference, owner)).toBe(false);
  });

  it("accepts a draft's reference only for that draft", () => {
    expect(isChannelSecretReferenceOwnedBy(draftReference, { connectionId, draftId: "draft-1" })).toBe(true);
    expect(isChannelSecretReferenceOwnedBy(draftReference, { connectionId, draftId: "draft-2" })).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(draftReference, { connectionId, draftId: "draft-10" })).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(draftReference, { connectionId: "draft-1" })).toBe(false);
  });

  it("owns nothing when there is no owner, or its connection id is blank", () => {
    expect(isChannelSecretReferenceOwnedBy(ownReference, undefined as never)).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(ownReference, null as never)).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(ownReference, { connectionId: "" })).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(ownReference, { connectionId: "  " })).toBe(false);
    expect(isChannelSecretReferenceOwnedBy(draftReference, { connectionId: "", draftId: "draft-1" })).toBe(false);
  });
});

describe("channelSecretOwnerForDraft", () => {
  it("names an edit draft's saved connection and the draft", () => {
    expect(channelSecretOwnerForDraft({ draftId: "draft-1", connectionId: "conn-1" })).toEqual({
      connectionId: "conn-1",
      draftId: "draft-1",
    });
  });

  it("makes a create draft's id its future connection's id, the way the setup test's connection is built", () => {
    expect(channelSecretOwnerForDraft({ draftId: "draft-1" })).toEqual({
      connectionId: "draft-1",
      draftId: "draft-1",
    });
  });
});

describe("resolveConnectionConfigSecret: a saved key is read only for the connection or draft that owns it", () => {
  const SECRET = "synthetic-owned-key-0003";
  const OTHER_SECRET = "synthetic-other-key-0004";
  const draftReference = "keychain:goatcitadel:channel-draft:draft-1:token:00000000-0000-4000-8000-000000000005";
  const otherDraftReference = "keychain:goatcitadel:channel-draft:draft-2:token:00000000-0000-4000-8000-000000000006";
  const secrets = new Map<string, string>();
  const store = { getSecret: vi.fn((account: string) => secrets.get(account)) };
  const accountOf = (reference: string) => reference.slice("keychain:goatcitadel:".length);
  const read = (
    config: Record<string, unknown>,
    owner: { connectionId: string; draftId?: string } | undefined,
    catalogId: string | undefined = "channel.mattermost",
  ) => resolveConnectionConfigSecret(store, config, "token", "tokenEnv", catalogId, owner as never);

  function capturedLog(run: () => void): string {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      run();
      return stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stderr.mockRestore();
    }
  }

  beforeEach(() => {
    secrets.clear();
    store.getSecret.mockClear();
    secrets.set(accountOf(ownReference), `  ${SECRET} `);
    secrets.set(accountOf(otherReference), OTHER_SECRET);
    secrets.set(accountOf(draftReference), SECRET);
    secrets.set(accountOf(otherDraftReference), OTHER_SECRET);
  });

  it("gives the trimmed key behind this connection's own reference", () => {
    expect(read({ token: ownReference }, { connectionId })).toBe(SECRET);
  });

  it("gives nothing for another connection's reference, and never reads the store for it", () => {
    expect(read({ token: otherReference }, { connectionId })).toBeUndefined();
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("does not fall back to the variable the config names when the reference is refused", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", OTHER_SECRET);

    expect(read({ token: otherReference, tokenEnv: "MATTERMOST_BOT_TOKEN" }, { connectionId })).toBeUndefined();
  });

  it("gives a draft's own reference to that draft's setup test, and not another draft's", () => {
    const owner = { connectionId: "draft-1", draftId: "draft-1" };

    expect(read({ token: draftReference }, owner)).toBe(SECRET);
    expect(read({ token: otherDraftReference }, owner)).toBeUndefined();
    expect(read({ token: draftReference }, { connectionId: "draft-1" })).toBeUndefined();
    expect(read({ token: draftReference }, { connectionId, draftId: "draft-2" })).toBeUndefined();
  });

  it("gives an edit draft both its saved connection's references and its own new draft references", () => {
    const owner = channelSecretOwnerForDraft({ draftId: "draft-1", connectionId });

    expect(read({ token: ownReference }, owner)).toBe(SECRET);
    expect(read({ token: draftReference }, owner)).toBe(SECRET);
    expect(read({ token: otherReference }, owner)).toBeUndefined();
    expect(read({ token: otherDraftReference }, owner)).toBeUndefined();
  });

  it("gives a create draft's own references under the id it will have as a connection", () => {
    const owner = channelSecretOwnerForDraft({ draftId: "draft-1" });
    const futureConnectionReference =
      "keychain:goatcitadel:channel-connection:draft-1:token:00000000-0000-4000-8000-000000000007";
    secrets.set(accountOf(futureConnectionReference), SECRET);

    expect(read({ token: draftReference }, owner)).toBe(SECRET);
    expect(read({ token: futureConnectionReference }, owner)).toBe(SECRET);
    expect(read({ token: ownReference }, owner)).toBeUndefined();
  });

  it("fails closed with no owner: no reference is read", () => {
    expect(read({ token: ownReference }, undefined)).toBeUndefined();
    expect(read({ token: ownReference }, { connectionId: "" })).toBeUndefined();
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("gives nothing for a malformed reference, or one the store cannot return", () => {
    expect(
      read({ token: "keychain:goatcitadel:channel-connection:not-a-valid-ref" }, { connectionId }),
    ).toBeUndefined();
    secrets.delete(accountOf(ownReference));
    expect(read({ token: ownReference }, { connectionId })).toBeUndefined();
    secrets.set(accountOf(ownReference), "   ");
    expect(read({ token: ownReference }, { connectionId })).toBeUndefined();
  });

  it("never reads the store for an approval token reference", () => {
    read(
      { token: "keychain:goatcitadel:approval-remote-action:00000000-0000-4000-8000-000000000008" },
      { connectionId },
    );

    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("returns a pasted key and reads a permitted variable as it did, whoever the owner is", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", `  ${SECRET} `);

    expect(read({ token: " pasted-key " }, { connectionId })).toBe("pasted-key");
    expect(read({ token: " pasted-key " }, undefined)).toBe("pasted-key");
    expect(read({ tokenEnv: "MATTERMOST_BOT_TOKEN" }, { connectionId })).toBe(`  ${SECRET} `);
    expect(read({ tokenEnv: "OPENAI_API_KEY" }, { connectionId })).toBeUndefined();
  });

  it("logs a refusal without the reference, the key, or either owner's id", () => {
    const logged = capturedLog(() => {
      read({ token: otherReference }, { connectionId });
      read({ token: otherDraftReference }, { connectionId, draftId: "draft-1" });
      read({ token: "keychain:goatcitadel:channel-connection:not-a-valid-ref" }, { connectionId });
    });

    expect(logged).toContain("Refusing to resolve");
    for (const text of [
      otherReference,
      otherDraftReference,
      accountOf(otherReference),
      "conn-2",
      "draft-2",
      OTHER_SECRET,
      SECRET,
    ]) {
      expect(logged).not.toContain(text);
    }
  });
});
