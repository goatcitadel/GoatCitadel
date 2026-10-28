import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapabilitySkillUsageResponse } from "@goatcitadel/contracts";
import { buildApp } from "./app.js";
import { RealtimeEventService } from "./services/realtime-event-service.js";

/**
 * The skill use counts over the real Gateway: the real chat turn profile history behind the composed service. The unit
 * tests fake that history; this one proves the composition reaches the real query on the migrated schema, that the
 * answer is cached, and that reading announces nothing.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const USAGE_URL = "/api/v1/capabilities/skills/usage";

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

describe("Capabilities skill use counts over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-skills-"));
    fs.cpSync(path.join(REPO_ROOT, "config"), path.join(root, "config"), { recursive: true });
    for (const [key, value] of Object.entries({ ...ENV, GOATCITADEL_ROOT_DIR: root })) {
      originalEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    app = await buildApp();
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    vi.restoreAllMocks();
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

  async function readUsage(refresh: boolean): Promise<CapabilitySkillUsageResponse> {
    const response = await app!.inject({ method: "GET", url: refresh ? `${USAGE_URL}?refresh=true` : USAGE_URL });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<CapabilitySkillUsageResponse>();
  }

  it("reads the real chat history, caches the answer, and announces nothing", async () => {
    const published: string[] = [];
    const publish = RealtimeEventService.prototype.publishRealtime;
    vi.spyOn(RealtimeEventService.prototype, "publishRealtime").mockImplementation(function (
      this: RealtimeEventService,
      ...args: Parameters<RealtimeEventService["publishRealtime"]>
    ) {
      published.push(`${args[1]}:${args[0]}`);
      return publish.apply(this, args);
    });

    const first = await readUsage(false);

    // A fresh install has no chat turns, so an empty list is the true answer (a failed read would be a 503).
    expect(first.skills).toEqual([]);
    expect(Date.parse(first.generatedAt) - Date.parse(first.since)).toBe(365 * 86_400_000);

    // The second read is the cached answer: it keeps the time of the read that filled the cache.
    expect(await readUsage(false)).toEqual(first);

    const refreshed = await readUsage(true);
    expect(Date.parse(refreshed.generatedAt)).toBeGreaterThanOrEqual(Date.parse(first.generatedAt));
    expect(published).toEqual([]);
    vi.restoreAllMocks();
  });
});
