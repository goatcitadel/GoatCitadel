import { afterEach, describe, expect, it, vi } from "vitest";
import { persistMcpOAuthTokenResponse } from "./mcp-oauth-token-persistence.js";

describe("MCP OAuth token persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { label: "invalid absolute timestamp", expiry: { expires_at: "invalid timestamp" } },
    { label: "unrepresentable lifetime", expiry: { expires_in: Number.MAX_VALUE } },
  ])("rejects an $label before staging credentials", async ({ expiry }) => {
    const setSecret = vi.fn();
    const stageCredentials = vi.fn(async (_serverId: string, _refs: readonly string[], write: () => undefined) => {
      write();
    });
    const discardUnpublishedAccounts = vi.fn();

    await expect(
      persistMcpOAuthTokenResponse(
        { secretStore: { setSecret }, stageCredentials },
        "fixture-server",
        { access_token: "fixture-value", ...expiry },
        { updatedAt: "2026-07-09T12:00:00.000Z" },
        discardUnpublishedAccounts,
      ),
    ).rejects.toThrow();

    expect(stageCredentials).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    expect(discardUnpublishedAccounts).not.toHaveBeenCalled();
  });

  it.each([
    { label: "absolute timestamp", expiry: { expires_at: "2026-07-09T13:00:00.000Z" }, expected: "2026-07-09T13:00:00.000Z" },
    { label: "relative lifetime", expiry: { expires_in: 3600 }, expected: "2026-07-09T13:00:00.000Z" },
    { label: "omitted expiry", expiry: {}, expected: undefined },
  ])("accepts $label", async ({ expiry, expected }) => {
    vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
    const setSecret = vi.fn();

    const result = await persistMcpOAuthTokenResponse(
      { secretStore: { setSecret } },
      "fixture-server",
      { access_token: "fixture-value", ...expiry },
      { updatedAt: "2026-07-09T12:00:00.000Z" },
      vi.fn(),
    );

    expect(result.tokenExpiresAt).toBe(expected);
    expect(setSecret).toHaveBeenCalledOnce();
  });
});
