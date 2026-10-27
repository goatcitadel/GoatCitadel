import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectionSecretReferenceResolver,
  readConfigSecret,
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
    expect(readReference).toHaveBeenCalledWith(ownReference);
  });

  it("checks the owner on the trimmed reference and reads with the trimmed reference", () => {
    const readReference = vi.fn(() => "real-secret");

    expect(createConnectionSecretReferenceResolver(connectionId, readReference)(`  ${ownReference}\n`)).toBe(
      "real-secret",
    );
    expect(readReference).toHaveBeenCalledWith(ownReference);
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
