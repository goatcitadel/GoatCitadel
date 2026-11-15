import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { describe, expect, it } from "vitest";
import {
  DISCORD_NO_KEY_STORE,
  isNoKeyStoreFailure,
  noKeyStoreLinkText,
  SLACK_NO_KEY_STORE,
  TELEGRAM_NO_KEY_STORE,
} from "./no-key-store";

function httpError(status: number, body: unknown): ApiRequestError {
  return new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/x", status, body });
}

describe("no key store", () => {
  it("pins the Telegram sentence", () => {
    expect(TELEGRAM_NO_KEY_STORE).toBe(
      "This page stores your key in this computer's secure storage, which isn't available here. Use Telegram's guide in Advanced channel setup with environment variables instead.",
    );
  });

  it("names each channel's guide inside its sentence", () => {
    expect(DISCORD_NO_KEY_STORE).toContain(noKeyStoreLinkText("Discord"));
    expect(DISCORD_NO_KEY_STORE).toContain("your token in");
    expect(SLACK_NO_KEY_STORE).toContain(noKeyStoreLinkText("Slack"));
    expect(SLACK_NO_KEY_STORE).toContain("your tokens in");
  });

  it("recognises the Gateway's sentence at any status and nothing else", () => {
    expect(isNoKeyStoreFailure(httpError(422, { error: "Secure channel credential storage is unavailable." }))).toBe(
      true,
    );
    expect(isNoKeyStoreFailure(httpError(500, { message: "Secure channel credential storage is unavailable." }))).toBe(
      true,
    );
    expect(
      isNoKeyStoreFailure(httpError(400, { error: "Secure channel credential storage is unavailable. Bearer x" })),
    ).toBe(false);
    expect(isNoKeyStoreFailure(new Error("Secure channel credential storage is unavailable."))).toBe(false);
  });
});
