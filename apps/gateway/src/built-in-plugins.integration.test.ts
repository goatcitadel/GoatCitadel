import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CapabilityPluginInspection, CapabilityPluginListResponse } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";

/**
 * The plugins that ship with GoatCitadel, on a fresh install over the real Gateway: the repository's own `plugins/`
 * and `skills/` folders are copied into a scratch root beside the example config, as a new install starts, and Browser
 * checks is listed and inspected through the same routes the Plugins tab uses. Every piece goes through its owner's
 * own check (the skill through the Skill Hub's real review). On Windows the Skill Hub's artifact store sets owner-only
 * ACLs through PowerShell, so the waits here are generous.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN = "built-in-plugins-test-operator-1234567890";
const WORKSPACE_ID = "default";
const PLUGIN_ID = "browser-checks";
const PLUGINS_URL = `/api/v1/capabilities/plugins?workspaceId=${WORKSPACE_ID}`;
const INSPECTIONS_URL = "/api/v1/capabilities/plugins/inspections";

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  NODE_ENV: "test",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  GOATCITADEL_AUTH_MODE: "token",
  GOATCITADEL_AUTH_TOKEN: TOKEN,
  GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
};

describe("the plugins that ship with GoatCitadel, over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-built-in-plugins-"));
    writeConfig(path.join(root, "config"));
    // A fresh install's shipped folders: the plugins that ship, and the skills that ship beside them.
    fs.cpSync(path.join(REPO_ROOT, "plugins"), path.join(root, "plugins"), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, "skills"), path.join(root, "skills"), { recursive: true });
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    app = await buildApp();
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // A temp root that can't be removed is reported rather than left behind unseen: only the errors Windows raises while
    // a file is still closing are tried again.
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException).code);
        if (attempt >= 5 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  async function inject(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    return await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `built-in-plugins-${++sequence}` },
      ...(payload ? { payload } : {}),
    });
  }

  it("inspects Browser checks as installable on a fresh install", async () => {
    const listed = await inject("GET", PLUGINS_URL);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<CapabilityPluginListResponse>()).toEqual({
      installed: [],
      builtIn: [
        {
          pluginId: PLUGIN_ID,
          name: "Browser checks",
          description:
            "Lets the AI open pages in a private browser, read them and take screenshots, with a skill for checking web pages step by step.",
          version: "1.0.0",
          trust: "built_in",
          sourceDisplay: "Ships with GoatCitadel",
          state: "available",
          pieceCounts: { connector: 1, skill: 1 },
        },
      ],
    });

    const created = await inject("POST", INSPECTIONS_URL, {
      workspaceId: WORKSPACE_ID,
      source: { kind: "built_in", pluginId: PLUGIN_ID },
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const inspection = created.json<CapabilityPluginInspection>();
    expect(inspection).toMatchObject({
      workspaceId: WORKSPACE_ID,
      pluginId: PLUGIN_ID,
      name: "Browser checks",
      version: "1.0.0",
      author: "GoatCitadel",
      trust: "built_in",
      sourceKind: "built_in",
      sourceDisplay: "Ships with GoatCitadel",
      pin: { kind: "content" },
      installable: true,
      ignored: [],
    });
    expect(inspection.refusal).toBeUndefined();
    // In manifest order: the connector first, then the skill, each passing its own owner's check.
    expect(inspection.pieces.map(({ skillSnapshotId: _id, ...piece }) => piece)).toEqual([
      {
        pieceId: "playwright",
        kind: "connector",
        label: "Playwright Browser",
        asksFirst: "Everything it does asks first in Chat.",
        check: { status: "ready" },
        // The default network allowlist doesn't hold the package registry, so installing adds it.
        hosts: ["registry.npmjs.org"],
      },
      {
        pieceId: "browser-qa",
        kind: "skill",
        label: "browser-qa",
        asksFirst: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
        check: { status: "ready" },
      },
    ]);
    expect(inspection.pieces[1]?.skillSnapshotId).toEqual(expect.any(String));
    // No path on this computer reaches the operator.
    expect(created.body).not.toContain(root);
    expect(created.body).not.toContain(root.replaceAll("\\", "\\\\"));
  });
});

function writeConfig(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const repoConfig = path.join(REPO_ROOT, "config");
  for (const name of [
    "assistant.config.example.json",
    "tool-policy.example.json",
    "budgets.example.json",
    "cron-jobs.example.json",
  ]) {
    fs.copyFileSync(path.join(repoConfig, name), path.join(configDir, name));
  }
  const config = JSON.parse(fs.readFileSync(path.join(repoConfig, "goatcitadel.example.json"), "utf8"));
  config.assistant.approvalExplainer.enabled = false;
  fs.writeFileSync(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(configDir, "llm-model-metadata.json"), JSON.stringify({ version: 1, entries: {} }));
}
