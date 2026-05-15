import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadResolvedProfile, saveProfile, type TuiProfile } from "./profile.js";

const originalEnv = {
  GOATCITADEL_GATEWAY_URL: process.env.GOATCITADEL_GATEWAY_URL,
  GOATCITADEL_TUI_AUTH_MODE: process.env.GOATCITADEL_TUI_AUTH_MODE,
  GOATCITADEL_AUTH_TOKEN: process.env.GOATCITADEL_AUTH_TOKEN,
  GOATCITADEL_AUTH_BASIC_USERNAME: process.env.GOATCITADEL_AUTH_BASIC_USERNAME,
  GOATCITADEL_AUTH_BASIC_PASSWORD: process.env.GOATCITADEL_AUTH_BASIC_PASSWORD,
};

const tempRoots: string[] = [];
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.restoreAllMocks();
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    delete process.env[key];
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-tui-profile-"));
  tempRoots.push(root);
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(root);
});

afterEach(async () => {
  homedirSpy.mockRestore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("tui profile", () => {
  it("loads a sanitized default profile when no file exists", async () => {
    const resolved = await loadResolvedProfile({
      profileName: "ops/default?",
      gatewayOverride: " http://host:8787/// ",
    });

    expect(resolved.profileName).toBe("ops_default_");
    expect(resolved.filePath).toMatch(/tui-profile-ops_default_\.json$/);
    expect(resolved.profile).toMatchObject({
      gatewayBaseUrl: "http://host:8787",
      authMode: "none",
      tokenQueryParam: "access_token",
      defaultScope: "operator",
      pollIntervalsMs: {
        dashboard: 5000,
        activity: 2500,
        approvals: 5000,
      },
      ui: {
        denseMode: false,
        confirmRiskyWrites: true,
        colorLevel: "auto",
      },
    });
    expect(resolved.auth).toEqual({ mode: "none", token: undefined, username: undefined, password: undefined });
  });

  it("applies file values and environment auth overrides", async () => {
    const profilePath = path.join(os.homedir(), ".GoatCitadel", "tui-profile.json");
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        gatewayBaseUrl: "http://file-host:8787/",
        authMode: "basic",
        username: " file-user ",
        tokenQueryParam: " token ",
        defaultScope: "personal",
        pollIntervalsMs: { dashboard: 99, activity: 750, approvals: 120_000 },
        ui: { denseMode: true, confirmRiskyWrites: false, colorLevel: "off" },
      } satisfies TuiProfile),
      "utf8",
    );
    process.env.GOATCITADEL_GATEWAY_URL = " http://env-host:8787/ ";
    process.env.GOATCITADEL_TUI_AUTH_MODE = "token";
    process.env.GOATCITADEL_AUTH_TOKEN = " secret-token ";
    process.env.GOATCITADEL_AUTH_BASIC_USERNAME = " env-user ";
    process.env.GOATCITADEL_AUTH_BASIC_PASSWORD = "env-password";

    const resolved = await loadResolvedProfile({});

    expect(resolved.profile).toMatchObject({
      gatewayBaseUrl: "http://env-host:8787",
      authMode: "token",
      username: "file-user",
      tokenQueryParam: "token",
      defaultScope: "personal",
      pollIntervalsMs: { dashboard: 5000, activity: 750, approvals: 60000 },
      ui: { denseMode: true, confirmRiskyWrites: false, colorLevel: "off" },
    });
    expect(resolved.auth).toEqual({
      mode: "token",
      token: "secret-token",
      username: "env-user",
      password: "env-password",
    });
  });

  it("saves only sanitized profile values", async () => {
    const filePath = path.join(os.homedir(), ".GoatCitadel", "profile.json");

    await saveProfile(filePath, {
      gatewayBaseUrl: " http://save-host:8787/// ",
      authMode: "basic",
      username: " operator ",
      tokenQueryParam: " token ",
      defaultScope: "personal",
      pollIntervalsMs: { dashboard: 501.9, activity: Number.NaN, approvals: 100 },
      ui: { denseMode: true, confirmRiskyWrites: false, colorLevel: "off" },
    });

    await expect(fs.readFile(filePath, "utf8").then(JSON.parse)).resolves.toEqual({
      gatewayBaseUrl: "http://save-host:8787",
      authMode: "basic",
      username: "operator",
      tokenQueryParam: "token",
      defaultScope: "personal",
      pollIntervalsMs: { dashboard: 501, activity: 2500, approvals: 5000 },
      ui: { denseMode: true, confirmRiskyWrites: false, colorLevel: "off" },
    });
  });

  it("falls back to defaults for unreadable or invalid profile files", async () => {
    const profilePath = path.join(os.homedir(), ".GoatCitadel", "tui-profile.json");
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, "[invalid", "utf8");
    process.env.GOATCITADEL_TUI_AUTH_MODE = "unsupported";

    const resolved = await loadResolvedProfile({});

    expect(resolved.profile.gatewayBaseUrl).toBe("http://127.0.0.1:8787");
    expect(resolved.profile.authMode).toBe("none");
  });

  it("falls back to defaults when the profile JSON is not an object", async () => {
    const profilePath = path.join(os.homedir(), ".GoatCitadel", "tui-profile.json");
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, "[]", "utf8");

    const resolved = await loadResolvedProfile({});

    expect(resolved.profile.gatewayBaseUrl).toBe("http://127.0.0.1:8787");
    expect(resolved.profile.authMode).toBe("none");
  });
});
