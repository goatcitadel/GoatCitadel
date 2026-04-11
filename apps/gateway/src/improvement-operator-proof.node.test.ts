import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { buildApp } from "./app.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("improvement operator proof", () => {
  it("serves ledger and legacy improvement endpoints without server errors", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-improvement-operator-proof-"));
    tempRoots.push(tempRoot);

    await cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "transcripts"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "audit"), { recursive: true });
    await mkdir(path.join(tempRoot, "workspace"), { recursive: true });

    const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
    const priorAuthMode = process.env.GOATCITADEL_AUTH_MODE;
    const priorDisableSecretStore = process.env.GOATCITADEL_DISABLE_SECRET_STORE;
    const priorImprovementLedgerFlag = process.env.GOATCITADEL_FEATURE_IMPROVEMENT_LEDGER_V1_ENABLED;
    const priorImprovementActivationFlag = process.env.GOATCITADEL_FEATURE_IMPROVEMENT_ACTIVATION_V1_ENABLED;

    process.env.GOATCITADEL_ROOT_DIR = tempRoot;
    process.env.GOATCITADEL_AUTH_MODE = "none";
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = "true";
    process.env.GOATCITADEL_FEATURE_IMPROVEMENT_LEDGER_V1_ENABLED = "true";
    process.env.GOATCITADEL_FEATURE_IMPROVEMENT_ACTIVATION_V1_ENABLED = "true";

    const app = await buildApp();
    try {
      let mutationIndex = 0;
      const nextMutationHeaders = () => ({
        "Content-Type": "application/json",
        "Idempotency-Key": `improvement-operator-proof-${(mutationIndex += 1)}`,
      });
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/capability-gaps?limit=25" })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/repair-candidates?limit=25" })).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/v1/improvement/repair-candidates/missing/validation",
            headers: nextMutationHeaders(),
            payload: {
              status: "failed",
              summary: "operator proof",
            },
          })
        ).statusCode,
        404,
      );
      assert.equal((await app.inject({ method: "GET", url: "/api/v1/improvement/signals?limit=25" })).statusCode, 200);
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/candidates?limit=25" })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/signals/missing-signal" })).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/candidates/missing-candidate" })).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/improvement/candidates/missing-candidate/activation-request",
            headers: nextMutationHeaders(),
            payload: {},
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/v1/improvement/activations/missing-activation" })).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/improvement/activations/missing-activation/pause",
            headers: nextMutationHeaders(),
            payload: {},
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/improvement/activations/missing-activation/rollback",
            headers: nextMutationHeaders(),
            payload: {},
          })
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
      if (priorRoot === undefined) {
        delete process.env.GOATCITADEL_ROOT_DIR;
      } else {
        process.env.GOATCITADEL_ROOT_DIR = priorRoot;
      }
      if (priorAuthMode === undefined) {
        delete process.env.GOATCITADEL_AUTH_MODE;
      } else {
        process.env.GOATCITADEL_AUTH_MODE = priorAuthMode;
      }
      if (priorDisableSecretStore === undefined) {
        delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
      } else {
        process.env.GOATCITADEL_DISABLE_SECRET_STORE = priorDisableSecretStore;
      }
      if (priorImprovementLedgerFlag === undefined) {
        delete process.env.GOATCITADEL_FEATURE_IMPROVEMENT_LEDGER_V1_ENABLED;
      } else {
        process.env.GOATCITADEL_FEATURE_IMPROVEMENT_LEDGER_V1_ENABLED = priorImprovementLedgerFlag;
      }
      if (priorImprovementActivationFlag === undefined) {
        delete process.env.GOATCITADEL_FEATURE_IMPROVEMENT_ACTIVATION_V1_ENABLED;
      } else {
        process.env.GOATCITADEL_FEATURE_IMPROVEMENT_ACTIVATION_V1_ENABLED = priorImprovementActivationFlag;
      }
    }
  });
});
