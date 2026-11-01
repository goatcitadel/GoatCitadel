import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, redactSecretsInString } from "@goatcitadel/gateway-core";
import { keyStoreReferenceFingerprint, pluginSecretLogs } from "./capability-plugin-secret-logs.js";

// The server log lines about a plugin's stored signing secrets, through the real logger: the references they name
// must survive its redaction, as a fingerprint, while the secrets and the references themselves never appear.

const REF = "keychain:goatcitadel:hook:7f3c2a1e-9b4d-4c8e-a2f1-0d6b5e4c3a21";
const OTHER = "keychain:goatcitadel:hook:00000000-0000-4000-8000-000000000009";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The JSON lines the real logger writes to stderr while `write` runs. */
function loggedLines(write: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  write();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("a plugin's signing secret log lines", () => {
  it("would lose a key store reference to the logger's redaction, so a fingerprint stands in for it", () => {
    expect(redactSecretsInString(REF)).not.toContain("7f3c2a1e");
    expect(keyStoreReferenceFingerprint(REF)).toBe(
      `sha256:${createHash("sha256").update(REF).digest("hex").slice(0, 16)}`,
    );
    expect(redactSecretsInString(keyStoreReferenceFingerprint(REF))).toBe(keyStoreReferenceFingerprint(REF));
    expect(keyStoreReferenceFingerprint(OTHER)).not.toBe(keyStoreReferenceFingerprint(REF));
  });

  it("names the plugin and each kept reference when an uninstall couldn't tell which secrets hooks use", () => {
    const logs = pluginSecretLogs(logger.child("capability-plugins-test"));

    const [line] = loggedLines(() =>
      logs.reportUndecidedSecrets("meeting-tools", [REF, OTHER], new Error("too many hooks")),
    );

    expect(line).toMatchObject({
      level: "error",
      pluginId: "meeting-tools",
      keyStoreReferences: [keyStoreReferenceFingerprint(REF), keyStoreReferenceFingerprint(OTHER)],
      err: { name: "Error", message: "too many hooks" },
    });
    expect(JSON.stringify(line)).not.toContain("[redacted]");
    expect(JSON.stringify(line)).not.toContain("keychain:");
  });

  it("names the reference of a secret that couldn't be deleted", () => {
    const logs = pluginSecretLogs(logger.child("capability-plugins-test"));

    const [line] = loggedLines(() => logs.reportFailedSecretDelete(REF, new Error("key store is locked")));

    expect(line).toMatchObject({
      level: "error",
      keyStoreReference: keyStoreReferenceFingerprint(REF),
      err: { message: "key store is locked" },
    });
    expect(JSON.stringify(line)).not.toContain("[redacted]");
  });
});
