import { z } from "zod";
import type { ExtensionConfigurationField, ExtensionConfigurationForm } from "@goatcitadel/contracts";

export type { ExtensionConfigurationField, ExtensionConfigurationForm } from "@goatcitadel/contracts";
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const base = {
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u),
  label: text(120),
  help: text(1000).optional(),
  required: z.boolean().optional(),
};
const field = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("text"), defaultValue: z.string().max(1000).optional() }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("url"),
      defaultValue: z
        .string()
        .url()
        .max(2048)
        .refine((value) => {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          );
        }, "URL defaults must not contain credentials, query parameters or fragments.")
        .optional(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("number"), defaultValue: z.number().finite().optional() }).strict(),
  z.object({ ...base, kind: z.literal("boolean"), defaultValue: z.boolean().optional() }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("choice"),
      choices: z
        .array(z.object({ value: text(120), label: text(120) }).strict())
        .min(1)
        .max(32),
      defaultValue: text(120).optional(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("secret_ref"), referenceKind: z.enum(["environment", "credential"]) }).strict(),
]);

export const ExtensionConfigurationFormSchema = z
  .object({
    version: z.literal("goatcitadel.extension-configuration.v1"),
    fields: z.array(field).max(32),
    prerequisites: z.array(text(500)).max(12).optional(),
    sampleTask: z
      .object({ prompt: text(2000), expectedOutcome: text(1000) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((form, context) => {
    const keys = new Set<string>();
    form.fields.forEach((entry, index) => {
      if (keys.has(entry.key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fields", index, "key"],
          message: "Configuration field keys must be unique.",
        });
      keys.add(entry.key);
      if (entry.kind === "choice") {
        const choices = new Set(entry.choices.map((choice) => choice.value));
        if (
          choices.size !== entry.choices.length ||
          (entry.defaultValue !== undefined && !choices.has(entry.defaultValue))
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fields", index, "choices"],
            message: "Choice values must be unique and contain the declared default.",
          });
      }
    });
  });

export function validateExtensionConfigurationForm(input: unknown): ExtensionConfigurationForm {
  return ExtensionConfigurationFormSchema.parse(input) satisfies ExtensionConfigurationForm;
}

/** Project requirements only; this helper deliberately accepts names, not values. */
export function inspectExtensionConfigurationRequirements(
  form: ExtensionConfigurationForm,
  configuredKeys: readonly string[] = [],
) {
  const validated = validateExtensionConfigurationForm(form);
  const configured = new Set(configuredKeys);
  return validated.fields.map((entry: ExtensionConfigurationField) => ({
    key: entry.key,
    label: entry.label,
    kind: entry.kind,
    required: entry.required === true,
    status: configured.has(entry.key)
      ? ("declared_configured" as const)
      : entry.kind !== "secret_ref" && entry.defaultValue !== undefined
        ? ("default_available" as const)
        : entry.required
          ? ("missing" as const)
          : ("optional" as const),
  }));
}
