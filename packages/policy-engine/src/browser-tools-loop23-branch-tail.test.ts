import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolPolicyConfig } from "@goatcitadel/contracts";
import { executeBrowserTool } from "./browser-tools.js";

let tempRoot = "";

function createConfig(): ToolPolicyConfig {
  return {
    profiles: { minimal: ["browser.*"] },
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [tempRoot],
      readOnlyRoots: [tempRoot],
      networkAllowlist: ["example.com"],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

describe("browser tools loop 23 branch tails", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "browser-loop23-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("handles cookie filters, replacement, explicit false flags, and empty cookie arrays", async () => {
    const config = createConfig();
    const context = { sessionId: "browser-loop23-cookies" };

    await expect(executeBrowserTool("browser.cookies.set", { cookies: [] }, config, context)).rejects.toThrow(
      /requires a cookie object/i,
    );
    await expect(
      executeBrowserTool("browser.cookies.set", { name: "bad", value: "1" }, config, context),
    ).rejects.toThrow(/requires url or domain/i);

    const set = await executeBrowserTool(
      "browser.cookies.set",
      {
        cookies: [
          {
            name: "sid",
            value: "first",
            domain: ".example.com",
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
          {
            name: "sid",
            value: "second",
            domain: "example.com",
            path: "/",
            expires: 0,
          },
          {
            name: "url-cookie",
            value: "1",
            url: "https://example.com/app",
          },
        ],
      },
      config,
      context,
    );
    expect(set).toMatchObject({ action: "cookies.set", count: 3 });

    const byUrl = await executeBrowserTool(
      "browser.cookies.get",
      { url: "https://example.com/elsewhere" },
      config,
      context,
    );
    expect(byUrl).toMatchObject({ count: 3 });
    expect(byUrl.cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sid", value: "second", domain: "example.com" }),
        expect.objectContaining({ name: "url-cookie", value: "1" }),
      ]),
    );

    const clearedByPath = await executeBrowserTool(
      "browser.cookies.clear",
      { name: "sid", domain: ".example.com", path: "/" },
      config,
      context,
    );
    expect(clearedByPath).toMatchObject({ removed: 2, remaining: 1 });

    const clearedAll = await executeBrowserTool("browser.cookies.clear", {}, config, context);
    expect(clearedAll).toMatchObject({ removed: 1, remaining: 0 });
  });

  it("covers storage defaults, empty origins, scalar coercion, and clear misses", async () => {
    const config = createConfig();
    const context = { sessionId: "browser-loop23-storage" };

    await expect(executeBrowserTool("browser.storage.get", { storage: "invalid" }, config, context)).rejects.toThrow(
      /local, session, or both/i,
    );
    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", storage: "both", key: "x", value: "y" },
        config,
        context,
      ),
    ).rejects.toThrow(/local or session/i);
    await expect(
      executeBrowserTool(
        "browser.storage.set",
        { origin: "https://example.com", entries: { " ": "bad" } },
        config,
        context,
      ),
    ).rejects.toThrow(/empty key/i);
    await expect(executeBrowserTool("browser.storage.clear", { key: "only-key" }, config, context)).rejects.toThrow(
      /requires origin/i,
    );

    const localSet = await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com/app", entries: { count: 2, enabled: false } },
      config,
      context,
    );
    expect(localSet).toMatchObject({
      action: "storage.set",
      origin: "https://example.com",
      storage: "local",
      entries: { count: "2", enabled: "false" },
    });

    const sessionSet = await executeBrowserTool(
      "browser.storage.set",
      { origin: "https://example.com/app", storage: "session", key: "draft", value: true },
      config,
      context,
    );
    expect(sessionSet).toMatchObject({ storage: "session", entries: { draft: "true" } });

    const fullState = await executeBrowserTool("browser.storage.get", {}, config, context);
    expect(fullState).toMatchObject({
      storage: "both",
      localStorage: { "https://example.com": { count: "2", enabled: "false" } },
      sessionStorage: { "https://example.com": { draft: "true" } },
    });

    const localOnly = await executeBrowserTool("browser.storage.get", { storage: "local" }, config, context);
    expect(localOnly).toMatchObject({ sessionStorage: {} });

    const missedClear = await executeBrowserTool(
      "browser.storage.clear",
      { origin: "https://example.com", storage: "both", key: "missing" },
      config,
      context,
    );
    expect(missedClear).toMatchObject({ removed: 0 });

    const removed = await executeBrowserTool(
      "browser.storage.clear",
      { origin: "https://example.com", storage: "both" },
      config,
      context,
    );
    expect(removed).toMatchObject({ removed: 3 });
  });

  it("normalizes context configuration nulls, empty headers, reset, and validation errors", async () => {
    const config = createConfig();
    const context = { sessionId: "browser-loop23-context" };

    await expect(
      executeBrowserTool("browser.context.configure", { geolocation: "bad" }, config, context),
    ).rejects.toThrow(/geolocation must be an object/i);
    await expect(
      executeBrowserTool("browser.context.configure", { extraHTTPHeaders: [] }, config, context),
    ).rejects.toThrow(/extraHTTPHeaders must be an object/i);
    await expect(
      executeBrowserTool(
        "browser.context.configure",
        { httpCredentials: { username: "", password: "p" } },
        config,
        context,
      ),
    ).rejects.toThrow(/httpCredentials\.username is required/i);

    const configured = await executeBrowserTool(
      "browser.context.configure",
      {
        locale: " en-US ",
        timezoneId: " America/Los_Angeles ",
        geolocation: { latitude: 47.6, longitude: -122.3, accuracy: 0 },
        extraHTTPHeaders: {},
        httpCredentials: { username: "operator", password: "secret" },
      },
      config,
      context,
    );
    expect(configured).toMatchObject({
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      geolocation: { latitude: 47.6, longitude: -122.3, accuracy: 0 },
      extraHTTPHeaders: undefined,
      httpCredentialsConfigured: true,
    });

    const reset = await executeBrowserTool(
      "browser.context.configure",
      {
        reset: true,
        locale: null,
        timezoneId: null,
        geolocation: null,
        extraHTTPHeaders: null,
        httpCredentials: null,
      },
      config,
      context,
    );
    expect(reset).toMatchObject({
      locale: undefined,
      timezoneId: undefined,
      geolocation: undefined,
      extraHTTPHeaders: undefined,
      httpCredentialsConfigured: false,
    });
  });
});
