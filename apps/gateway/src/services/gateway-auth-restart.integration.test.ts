import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { readLocalEnvVar } from "../env-file.js";

const execFileAsync = promisify(execFile);

it("keeps Token mode and the approved credential usable after a Gateway restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-auth-restart-"));
  const configDir = path.join(root, "config");
  const examples = fileURLToPath(new URL("../../../../config/", import.meta.url));
  const token = randomBytes(32).toString("hex");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await fs.mkdir(configDir);
    const payload = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
    payload.assistant.auth = { mode: "none", allowLoopbackBypass: false };
    payload.assistant.database.driver = "sqlite";
    payload.assistant.approvalExplainer.enabled = false;
    await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(payload));
    await fs.copyFile(path.join(examples, "llm-model-metadata.json"), path.join(configDir, "llm-model-metadata.json"));
    vi.stubEnv("GOATCITADEL_ROOT_DIR", root);
    vi.stubEnv("GOATCITADEL_DATABASE_DRIVER", "sqlite");
    vi.stubEnv("GOATCITADEL_LOCAL_ENV_FILE", undefined);
    vi.stubEnv("GOATCITADEL_AUTH_MODE", undefined);
    vi.stubEnv("GOATCITADEL_AUTH_TOKEN", undefined);
    vi.stubEnv("GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS", undefined);
    vi.stubEnv("GOATCITADEL_FEATURE_EVOLUTION_CONTROL_PLANE_V1_ENABLED", "true");
    app = await buildApp();
    const before = await app.inject({ method: "GET", url: "/api/v1/settings" });
    expect(before.statusCode).toBe(200);
    expect(before.json().auth.mode).toBe("none");
    const save = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/settings",
      headers: { "idempotency-key": randomUUID() },
      payload: { expectedRevision: before.json().revision, mode: "token", token, allowLoopbackBypass: false },
    });
    expect(save.statusCode).toBe(200);
    const receipt = save.json().changePlanReceipt;
    expect(save.body.includes(token)).toBe(false);
    if (receipt) {
      expect(
        ["awaiting_approval", "completed", "applied"],
        JSON.stringify({
          status: receipt.status,
          action: receipt.requiredAction?.kind,
          summary: String(receipt.summary).replaceAll(token, "[redacted]"),
        }),
      ).toContain(receipt.status);
    }
    if (receipt?.requiredAction?.kind === "approval") {
      expect(readLocalEnvVar("GOATCITADEL_AUTH_TOKEN", { rootDir: root }).present).toBe(false);
      const approved = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${receipt.requiredAction.approvalId}/resolve`,
        headers: { "idempotency-key": randomUUID() },
        payload: { decision: "approve" },
      });
      expect(approved.statusCode).toBe(200);
      const advanced = await app.inject({
        method: "POST",
        url: `/api/v1/change-plans/${receipt.planId}/responses`,
        headers: { "idempotency-key": randomUUID() },
        payload: {
          workspaceId: "default",
          expectedRevision: receipt.revision,
          actionId: receipt.requiredAction.actionId,
          actionNonce: receipt.requiredAction.actionNonce,
          values: {},
        },
      });
      expect(advanced.statusCode).toBe(200);
      expect(advanced.json().status).toBe("completed");
    }
    const saved = readLocalEnvVar("GOATCITADEL_AUTH_TOKEN", { rootDir: root });
    expect(saved.value === token).toBe(true);
    expect((await fs.readFile(path.join(configDir, "goatcitadel.json"), "utf8")).includes(token)).toBe(false);

    await app.close();
    app = undefined;
    const env = { ...process.env };
    delete env.GOATCITADEL_AUTH_TOKEN;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
        if (process.env.GOATCITADEL_AUTH_TOKEN !== undefined) process.exit(2);
        const { buildApp } = await import("./src/app.ts");
        const gateway = await buildApp();
        try {
          const token = process.env.GOATCITADEL_AUTH_TOKEN;
          if (!token) process.exit(3);
          const url = "/api/v1/settings";
          const anonymous = await gateway.inject({ method: "GET", url });
          const signedIn = await gateway.inject({
            method: "GET", url, headers: { authorization: "Bearer " + token },
          });
          const { mode, tokenConfigured, allowLoopbackBypass } = signedIn.json().auth ?? {};
          if (anonymous.statusCode !== 401 || signedIn.statusCode !== 200 || mode !== "token" ||
              tokenConfigured !== true || allowLoopbackBypass !== false || signedIn.body.includes(token)) {
            process.exitCode = 4;
          } else {
            console.log("Token sign-in verified after Gateway restart");
          }
        } finally {
          await gateway.close();
        }
      `,
      ],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, timeout: 90_000 },
    );
    expect(stdout).toContain("Token sign-in verified after Gateway restart");
  } finally {
    await app?.close();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
