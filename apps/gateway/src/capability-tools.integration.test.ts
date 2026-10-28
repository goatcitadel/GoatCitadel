import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOL_GROUPS, type CapabilityToolsResponse } from "@goatcitadel/contracts";
import { ToolAccessDecisionRepository } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { RealtimeEventService } from "./services/realtime-event-service.js";

/**
 * The tool group list over the real Gateway: the real policy engine, Settings and registry behind the composed
 * service. The unit tests fake every source; this one proves the composition reaches the real ones, that the list
 * is read-only, and that a switch shows on the very next request.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LIST_URL = "/api/v1/capabilities/tools?workspaceId=default";

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

describe("Capabilities tool groups over the real Gateway", { timeout: 300_000 }, () => {
  const originalEnv = new Map<string, string | undefined>();
  let root = "";
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-capability-tools-"));
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

  async function readList(): Promise<CapabilityToolsResponse> {
    const response = await app!.inject({ method: "GET", url: LIST_URL });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<CapabilityToolsResponse>();
  }

  it("lists every group from the real policy engine without recording or announcing anything", async () => {
    const recorded = vi.spyOn(ToolAccessDecisionRepository.prototype, "record");
    const published: string[] = [];
    const publish = RealtimeEventService.prototype.publishRealtime;
    vi.spyOn(RealtimeEventService.prototype, "publishRealtime").mockImplementation(function (
      this: RealtimeEventService,
      ...args: Parameters<RealtimeEventService["publishRealtime"]>
    ) {
      published.push(`${args[1]}:${args[0]}`);
      return publish.apply(this, args);
    });

    const list = await readList();

    expect(list.workspaceId).toBe("default");
    expect(list.groups.map((group) => group.groupId)).toEqual(TOOL_GROUPS.map((group) => group.id));
    expect(list.groups.find((group) => group.groupId === "core")?.state).toBe("always_on");
    expect(list.groups.filter((group) => group.groupId !== "core").every((group) => group.state === "on")).toBe(true);
    // A read-only tool in an on group is answered by the engine: allowed, so it asks first or runs freely.
    const read = list.groups
      .find((group) => group.groupId === "files")
      ?.tools.find((tool) => tool.toolName === "fs.read");
    expect(read?.blockedBy).toBeUndefined();
    expect(["asks_first", "runs_freely"]).toContain(read?.asks);
    expect(list.issues).toEqual([]);
    expect(recorded).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    vi.restoreAllMocks();
  });

  it("shows a group switch on the next request", async () => {
    const before = await readList();
    expect(before.groups.find((group) => group.groupId === "git")?.state).toBe("on");

    const saved = await app!.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { "idempotency-key": "capability-tools-integration-git-off" },
      payload: { expectedRevision: before.settingsRevision, toolGroupChange: { groupId: "git", enabled: false } },
    });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    const after = await readList();
    const git = after.groups.find((group) => group.groupId === "git");
    expect(git?.state).toBe("off");
    // A switched-off group is not checked, so its tools read as unknown and no rule is named.
    expect(git?.tools.length).toBeGreaterThan(0);
    expect(git?.tools.every((tool) => tool.asks === "unknown" && tool.blockedBy === undefined)).toBe(true);
    expect(after.settingsRevision).toBeGreaterThan(before.settingsRevision);
    expect(after.groups.find((group) => group.groupId === "files")?.state).toBe("on");
  });
});
