import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ExtensionConfigurationFormSchema, inspectExtensionConfigurationRequirements } from "./configuration-form.js";
import {
  preflightIntegrationPluginAuthorManifest,
  validateIntegrationPluginAuthorManifestDetailed,
} from "./integration-plugins.js";

const form = {
  version: "goatcitadel.extension-configuration.v1" as const,
  fields: [
    {
      key: "endpoint",
      label: "Endpoint",
      kind: "url" as const,
      required: true,
      defaultValue: "https://example.invalid/api",
    },
    {
      key: "credential",
      label: "Saved credential",
      kind: "secret_ref" as const,
      referenceKind: "credential" as const,
      required: true,
    },
    {
      key: "mode",
      label: "Mode",
      kind: "choice" as const,
      choices: [{ label: "Read only", value: "read" }],
      defaultValue: "read",
    },
  ],
  prerequisites: ["Install the declared server version"],
  sampleTask: {
    prompt: "Inspect one authorized fixture and summarize it.",
    expectedOutcome: "A cited fixture summary.",
  },
};
const manifest = { pluginId: "fixture", label: "Fixture", version: "1.0.0", capabilities: ["fixture.inspect"] };

describe("versioned extension configuration metadata", () => {
  it("keeps old manifests valid and binds new metadata into the existing descriptor hash", () => {
    const legacy = validateIntegrationPluginAuthorManifestDetailed(manifest);
    expect(legacy.ok).toBe(true);
    if (legacy.ok)
      expect(legacy.descriptorHash).toBe(createHash("sha256").update(JSON.stringify(manifest)).digest("hex"));
    const withForm = validateIntegrationPluginAuthorManifestDetailed({ ...manifest, configurationForm: form });
    expect(withForm.ok).toBe(true);
    if (withForm.ok && legacy.ok) {
      expect(withForm.manifest.configurationForm).toEqual(form);
      expect(withForm.descriptorHash).not.toBe(legacy.descriptorHash);
    }
  });

  it("rejects unsupported versions, duplicate keys, invalid defaults and oversized form metadata", () => {
    for (const invalid of [
      { ...form, version: "future" },
      { ...form, fields: [form.fields[0], form.fields[0]] },
      { ...form, fields: [{ ...form.fields[2], defaultValue: "write" }] },
      {
        ...form,
        fields: [
          {
            ...form.fields[2],
            choices: [
              { label: "First", value: "read" },
              { label: "Second", value: "read" },
            ],
          },
        ],
      },
      { ...form, fields: [{ key: "x", label: "X", kind: "number", defaultValue: Infinity }] },
      {
        ...form,
        fields: Array.from({ length: 33 }, (_, index) => ({ key: `field${index}`, label: "Field", kind: "text" })),
      },
    ])
      expect(ExtensionConfigurationFormSchema.safeParse(invalid).success).toBe(false);
  });

  it("forbids secret values/defaults and credential-bearing URLs without echoing values in diagnostics", () => {
    for (const invalidField of [
      { ...form.fields[1], defaultValue: "PRIVATE_TEST_SENTINEL" },
      { ...form.fields[1], value: "PRIVATE_TEST_SENTINEL" },
      { ...form.fields[1], example: "PRIVATE_TEST_SENTINEL" },
      { ...form.fields[1], referenceKind: "PRIVATE_TEST_SENTINEL" },
      { ...form.fields[0], defaultValue: "https://user:PRIVATE_TEST_SENTINEL@example.invalid" },
      { ...form.fields[0], defaultValue: "https://example.invalid?token=PRIVATE_TEST_SENTINEL" },
    ]) {
      const result = preflightIntegrationPluginAuthorManifest({
        ...manifest,
        configurationForm: { ...form, fields: [invalidField] },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TEST_SENTINEL");
    }
  });

  it("returns static missing key names and preserves the distinction between configuration and runtime proof", () => {
    const inspected = inspectExtensionConfigurationRequirements(form, []);
    expect(inspected.map((entry) => entry.status)).toEqual(["default_available", "missing", "default_available"]);
    const incomplete = preflightIntegrationPluginAuthorManifest({ ...manifest, configurationForm: form });
    expect(incomplete).toMatchObject({
      ok: true,
      missingRequiredKeys: ["credential"],
      scope: "static_author_metadata",
      runtimeVerified: false,
    });
    const configured = preflightIntegrationPluginAuthorManifest({ ...manifest, configurationForm: form }, [
      "credential",
    ]);
    expect(configured).toMatchObject({ ok: true, missingRequiredKeys: [], runtimeVerified: false });
    expect(JSON.stringify(configured)).not.toContain("defaultValue");
  });
});
