import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findArtifactRedactionFindings } from "./verify-artifact-redaction.mjs";

test("artifact redaction scan passes when the artifact directory is missing", async () => {
  const root = path.join(os.tmpdir(), `goatcitadel-redaction-missing-${Date.now()}`);
  assert.deepEqual(await findArtifactRedactionFindings(root), []);
});

test("artifact redaction scan reports secret-shaped values without returning the secret", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-"));
  await fs.mkdir(path.join(root, "diagnostics"), { recursive: true });
  await fs.writeFile(
    path.join(root, "diagnostics", "request.log"),
    "Authorization: Bearer sk-test-secret-value-that-should-not-be-printed",
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);

  assert.ok(findings.length >= 1);
  assert.ok(findings.every((item) => item.file === "diagnostics/request.log"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("sk-test-secret-value")));
});

test("artifact redaction scan catches JSON provider secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-json-"));
  await fs.writeFile(path.join(root, "payload.json"), '{"apiKey":"provider-secret-value-1234567890"}', "utf8");

  assert.deepEqual(await findArtifactRedactionFindings(root), [
    {
      file: "payload.json",
      ruleId: "provider-secret-json",
    },
  ]);
});

test("artifact redaction scan catches env and query-string provider secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-env-url-"));
  await fs.writeFile(
    path.join(root, "run.env"),
    [
      "OPENAI_API_KEY=sk-test-secret-value-that-must-not-print",
      "CALLBACK_URL=https://example.com/hook?access_token=query-secret-value-1234567890",
    ].join("\n"),
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);

  assert.deepEqual(
    findings.map((item) => item.ruleId).sort(),
    ["openai-style-key", "provider-secret-env", "provider-secret-url-query"].sort(),
  );
  assert.ok(findings.every((item) => item.file === "run.env"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("secret-value")));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("query-secret")));
});

test("artifact redaction scan catches common provider token shapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-provider-shapes-"));
  await fs.writeFile(
    path.join(root, "tokens.txt"),
    [
      "anthropic=sk-ant-test-token-that-is-long-enough-for-proof",
      "github=ghp_abcdefghijklmnopqrstuvwxyz123456",
    ].join("\n"),
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);

  assert.deepEqual(
    findings.map((item) => item.ruleId).sort(),
    ["anthropic-style-key", "github-style-token"].sort(),
  );
  assert.ok(findings.every((item) => item.file === "tokens.txt"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("abcdefghijklmnopqrstuvwxyz")));
});
