import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  assertArtifactRedactionGate,
  findArtifactRedactionFindings,
  scanArtifactFile,
} from "./verify-artifact-redaction.mjs";

test("artifact redaction scan passes when the artifact directory is missing", async () => {
  const root = path.join(os.tmpdir(), `goatcitadel-redaction-missing-${Date.now()}`);
  assert.deepEqual(await findArtifactRedactionFindings(root), []);
});

test("artifact redaction gate fails closed when the exact artifact root is missing", async () => {
  const root = path.join(os.tmpdir(), `goatcitadel-redaction-gate-missing-${Date.now()}`);
  await assert.rejects(assertArtifactRedactionGate(root), /gate root does not exist/u);
});

test("artifact redaction gate rejects a file in place of the exact artifact root", async () => {
  const root = path.join(os.tmpdir(), `goatcitadel-redaction-gate-file-${Date.now()}`);
  await fs.writeFile(root, "not a directory", "utf8");
  try {
    await assert.rejects(assertArtifactRedactionGate(root), /gate root is not a directory/u);
  } finally {
    await fs.rm(root, { force: true });
  }
});

test("artifact redaction gate rejects nested links without dereferencing their targets", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-link-"));
  const root = path.join(parent, "exact-run");
  const external = path.join(parent, "external-target");
  await fs.mkdir(root);
  await fs.mkdir(external);
  await fs.writeFile(
    path.join(external, "provider.log"),
    "Authorization: Bearer sk-external-link-target-must-not-be-read",
    "utf8",
  );
  try {
    await fs.symlink(external, path.join(root, "linked-evidence"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(assertArtifactRedactionGate(root), /could not scan every artifact/u);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("artifact redaction scan fails closed when a file cannot be read", async () => {
  const filePath = path.join(os.tmpdir(), `goatcitadel-redaction-unreadable-${Date.now()}.log`);

  assert.deepEqual(await scanArtifactFile(filePath), ["unscanned-file"]);
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

test("artifact redaction scan catches PostgreSQL credential URLs without returning credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-postgres-url-"));
  await fs.writeFile(
    path.join(root, "gateway.log"),
    "connect failed: postgresql://postgres:database-secret-value@127.0.0.1:55432/goatcitadel",
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);
  assert.deepEqual(findings, [{ file: "gateway.log", ruleId: "database-credential-url" }]);
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("database-secret-value")));
});

test("artifact redaction scan catches raw JSON database credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-database-json-"));
  await fs.writeFile(
    path.join(root, "gateway.json"),
    JSON.stringify({
      password: "database-password-value-1234567890",
      connectionString: "opaque-managed-database-connection-value",
    }),
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);
  assert.deepEqual(findings, [{ file: "gateway.json", ruleId: "database-secret-json" }]);
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("database-password")));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("opaque-managed")));
});

test("artifact redaction scan catches common provider token shapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-provider-shapes-"));
  await fs.writeFile(
    path.join(root, "tokens.txt"),
    ["anthropic=sk-ant-test-token-that-is-long-enough-for-proof", "github=ghp_abcdefghijklmnopqrstuvwxyz123456"].join(
      "\n",
    ),
    "utf8",
  );

  const findings = await findArtifactRedactionFindings(root);

  assert.deepEqual(findings.map((item) => item.ruleId).sort(), ["anthropic-style-key", "github-style-token"].sort());
  assert.ok(findings.every((item) => item.file === "tokens.txt"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("abcdefghijklmnopqrstuvwxyz")));
});

test("artifact redaction scan inspects compressed Playwright trace entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-zip-"));
  const secret = "Authorization: Bearer sk-compressed-artifact-secret-value-1234567890";
  const archive = createDeflatedZip("trace.trace", Buffer.from(secret, "utf8"));
  assert.equal(archive.includes(Buffer.from(secret, "utf8")), false);
  await fs.writeFile(path.join(root, "failure-trace.zip"), archive);

  const findings = await findArtifactRedactionFindings(root);

  assert.deepEqual(
    findings.map((item) => item.ruleId).sort(),
    ["authorization-header", "bearer-token", "openai-style-key"].sort(),
  );
  assert.ok(findings.every((item) => item.file === "failure-trace.zip"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("compressed-artifact-secret")));
});

test("artifact redaction scan fails closed on an unreadable zip structure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-bad-zip-"));
  await fs.writeFile(path.join(root, "failure-trace.zip"), Buffer.from("PK\u0003\u0004not-a-complete-archive"));

  assert.deepEqual(await findArtifactRedactionFindings(root), [
    { file: "failure-trace.zip", ruleId: "unscanned-archive" },
  ]);
});

test("artifact redaction scan streams secret-bearing files larger than ten MiB across chunk boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-redaction-large-"));
  const prefix = `${"x".repeat(65_529)}\n`;
  const secret = "Authorization: Bearer sk-large-artifact-secret-that-must-never-be-skipped";
  const suffix = "y".repeat(11 * 1024 * 1024);
  await fs.writeFile(path.join(root, "large-trace.log"), `${prefix}${secret}${suffix}`, "utf8");

  const findings = await findArtifactRedactionFindings(root);

  assert.deepEqual(
    findings.map((item) => item.ruleId).sort(),
    ["authorization-header", "bearer-token", "openai-style-key"].sort(),
  );
  assert.ok(findings.every((item) => item.file === "large-trace.log"));
  assert.ok(findings.every((item) => !JSON.stringify(item).includes("large-artifact-secret")));
});

function createDeflatedZip(nameValue, data) {
  const name = Buffer.from(nameValue, "utf8");
  const compressed = deflateRawSync(data);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x0800, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x0800, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);
  centralHeader.writeUInt32LE(0, 42);

  const centralOffset = localHeader.length + name.length + compressed.length;
  const centralDirectory = Buffer.concat([centralHeader, name]);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localHeader, name, compressed, centralDirectory, endRecord]);
}
