import type { ChannelSetupDefinition, IntegrationFormSchema } from "@goatcitadel/contracts";

export function collectDefinitionFieldHints(definition: ChannelSetupDefinition) {
  const fields = definition.wizard.steps.flatMap((step) => step.fields ?? []);
  return fields.slice(0, 10).map((field) => ({
    label: field.label,
    explanation: field.explanation,
    type: field.type,
  }));
}

export function applyIntegrationDefaults(
  schema: IntegrationFormSchema,
  current: Record<string, unknown>,
): Record<string, unknown> {
  return schema.fields.reduce<Record<string, unknown>>(
    (next, field) => {
      if (next[field.key] === undefined && field.defaultValue !== undefined) {
        next[field.key] = field.defaultValue;
      }
      return next;
    },
    { ...current },
  );
}

export function preferredChannelDefinition(definitions: ChannelSetupDefinition[]): ChannelSetupDefinition | undefined {
  return (
    definitions.find((item) => item.catalog.catalogId === "channel.slack") ??
    definitions.find((item) => item.catalog.catalogId === "channel.telegram") ??
    definitions[0]
  );
}
