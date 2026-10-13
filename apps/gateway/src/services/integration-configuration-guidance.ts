import type {
  ExtensionConfigurationField,
  IntegrationCatalogEntry,
  IntegrationFieldSchema,
  IntegrationFormSchema,
  IntegrationPluginRecord,
} from "@goatcitadel/contracts";
import { ExtensionConfigurationFormSchema } from "@goatcitadel/extensions-sdk";

/** Keep malformed or future stored metadata out of operator renderers without changing the installed record. */
export function projectIntegrationPluginConfiguration(plugin: IntegrationPluginRecord): IntegrationPluginRecord {
  if (plugin.configurationForm === undefined) return plugin;
  const parsed = ExtensionConfigurationFormSchema.safeParse(plugin.configurationForm);
  if (parsed.success) return { ...plugin, configurationForm: parsed.data };
  return {
    ...plugin,
    configurationForm: undefined,
    trustWarnings: [
      ...(plugin.trustWarnings ?? []),
      {
        code: "configuration.metadata_unsupported",
        severity: "warning",
        message:
          "Extension setup guidance is invalid or uses an unsupported version. Use the connector's existing setup fields or update the extension.",
      },
    ],
  };
}

/** Match existing owner fields only. Author metadata cannot mint settings or credential inputs. */
function matchesField(field: IntegrationFieldSchema, declared: ExtensionConfigurationField): boolean {
  if (declared.kind === "secret_ref") {
    return (
      declared.referenceKind === "environment" &&
      field.secretRef === true &&
      field.type === "text" &&
      field.key.endsWith("Env")
    );
  }
  if (field.secretRef || field.type === "password") return false;
  return field.type === (declared.kind === "choice" ? "select" : declared.kind);
}

export function projectIntegrationConfigurationGuidance(
  schema: IntegrationFormSchema,
  catalog: Pick<IntegrationCatalogEntry, "pluginId"> | undefined,
  plugins: readonly IntegrationPluginRecord[],
): IntegrationFormSchema {
  if (!catalog?.pluginId) return schema;
  const matching = plugins.filter((plugin) => plugin.pluginId === catalog.pluginId);
  if (matching.length !== 1) return schema;
  const plugin = matching[0]!;
  if (
    plugin.integrityStatus === "quarantined" ||
    plugin.integrityStatus === "mismatch" ||
    plugin.descriptorHealth?.status === "quarantined"
  )
    return schema;
  const parsed = ExtensionConfigurationFormSchema.safeParse(plugin.configurationForm);
  if (!parsed.success) return schema;
  const form = parsed.data;
  const supportedFieldKeys: string[] = [];
  const fields = schema.fields.map((field) => {
    const declared = form.fields.find((candidate) => candidate.key === field.key && matchesField(field, candidate));
    if (!declared) return field;
    supportedFieldKeys.push(field.key);
    // Labels/help supplement the owner. Requiredness, types, choices, defaults and secret custody remain unchanged.
    return {
      ...field,
      label: declared.label,
      description: [field.description, declared.help].filter(Boolean).join("\n") || undefined,
    };
  });
  return {
    ...schema,
    fields,
    configurationGuidance: { pluginId: plugin.pluginId, pluginVersion: plugin.version, form, supportedFieldKeys },
  };
}
