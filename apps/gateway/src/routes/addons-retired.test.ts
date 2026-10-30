import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * The add-on applications (Arena and the install, launch and slot machinery behind it) are retired.
 * This boots the real Gateway so the check covers what `app.ts` actually registers, not one plugin.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const ENV: Record<string, string> = {
  GATEWAY_HOST: "127.0.0.1",
  GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
  GOATCITADEL_AUTH_MODE: "none",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
  GOATCITADEL_RATE_LIMIT_ENABLED: "false",
};

describe("retired add-on routes", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-addons-retired-"));
    fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
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
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });

  it("answers 404 for the retired add-on routes", async () => {
    const catalog = await app!.inject({ method: "GET", url: "/api/v1/addons/catalog" });
    expect(catalog.statusCode).toBe(404);

    const install = await app!.inject({
      method: "POST",
      url: "/api/v1/addons/arena/install",
      headers: { "idempotency-key": "retired-addons-install-1" },
      payload: { confirmRepoDownload: true },
    });
    expect(install.statusCode).toBe(404);
  });

  it("registers no route under the add-ons family", () => {
    const addonRoutes = app!.routeAccessManifest.filter((entry) => entry.url.startsWith("/api/v1/addons"));
    expect(addonRoutes).toEqual([]);
  });
});
