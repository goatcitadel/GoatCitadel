import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectAuthorManifestSource } from "./author-preflight-cli.js";

it("reads local author metadata and sanitizes unreadable or invalid source diagnostics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "extension-preflight-"));
  try {
    const source = path.join(directory, "goatcitadel.integration-plugin.json");
    fs.writeFileSync(
      source,
      JSON.stringify({ pluginId: "fixture", label: "Fixture", version: "1.0.0", capabilities: ["fixture.inspect"] }),
    );
    expect(inspectAuthorManifestSource(source)).toMatchObject({ ok: true, runtimeVerified: false });
    fs.writeFileSync(source, '{"PRIVATE_TEST_SENTINEL":');
    const invalid = inspectAuthorManifestSource(source);
    expect(invalid.ok).toBe(false);
    expect(JSON.stringify(invalid)).not.toContain("PRIVATE_TEST_SENTINEL");
    expect(inspectAuthorManifestSource(path.join(directory, "missing.json")).ok).toBe(false);
    expect(() => inspectAuthorManifestSource(source, ["key=PRIVATE_TEST_SENTINEL"])).toThrow("key names only");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
