import { isDeepStrictEqual } from "node:util";
import { ValidationError } from "@goatcitadel/contracts";
import { getIntegrationFormSchema } from "./integration-catalog.js";
import { projectPublicSecretValue } from "./public-secret-projection.js";

/** Public configuration is never a credential transport. Existing masked leaves are reconciled by their owner. */
export function assertIntegrationPublicInput(catalogId: string, config: Record<string, unknown> | undefined, currentConfig?: Record<string, unknown>): void {
  if (!config) return;
  const fields = getIntegrationFormSchema(catalogId)?.fields ?? [];
  const projected = projectPublicSecretValue(config);
  const currentProjected = currentConfig ? projectPublicSecretValue(currentConfig) : undefined;
  function reject(): never {
    throw new ValidationError({
      message:
        "Credentials cannot be submitted in integration configuration. Use channel secure setup or this connector's supported credential reference.",
    });
  }
  function hasMask(value: unknown): boolean {
    return /(?:\[|%5b)REDACTED(?:\]|%5d)/iu.test(JSON.stringify(value) ?? "");
  }
  function validate(value: unknown, publicValue: unknown, previous: unknown, previousPublic: unknown): void {
    // Only the exact saved public projection can stand in for a secret. The
    // existing update owner restores it, with the service's revision CAS intact.
    if (hasMask(value) && !isDeepStrictEqual(previous, previousPublic) && isDeepStrictEqual(value, previousPublic)) return;
    if (typeof value === "string" && hasMask(value)) reject();
    if (isDeepStrictEqual(value, publicValue) && !hasMask(value)) return;
    if (value && typeof value === "object" && !Array.isArray(value)
      && publicValue && typeof publicValue === "object" && !Array.isArray(publicValue)) {
      for (const [key, child] of Object.entries(value)) {
        const own = (record: unknown) => record && typeof record === "object" && Object.hasOwn(record, key)
          ? (record as Record<string, unknown>)[key] : undefined;
        validate(child, own(publicValue), own(previous), own(previousPublic));
      }
      return;
    }
    reject();
  }
  for (const [key, value] of Object.entries(config)) {
    const field = fields.find(candidate => candidate.key === key);
    // URL schema fields are endpoints, even when marked secretRef. Preserve
    // response redaction but accept only URLs whose value has no credentials.
    if (field?.type === "url" && typeof value === "string" && !hasMask(value)) {
      if (value === "") continue;
      // WHATWG parsing removes control characters and treats backslashes as
      // separators. Never let those spellings bypass the public text owner.
      // eslint-disable-next-line no-control-regex -- endpoint URLs must reject control bytes before WHATWG parsing silently strips them.
      if (/[\u0000-\u0020\u007f\\]/u.test(value)) reject();
      let url: URL;
      try { url = new URL(value); } catch { reject(); }
      const canonical = url.href;
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
        || hasMask(canonical) || !isDeepStrictEqual(value, projectPublicSecretValue(value))
        || !isDeepStrictEqual(canonical, projectPublicSecretValue(canonical))) reject();
      continue;
    }
    validate(value, projected[key], currentConfig?.[key], currentProjected?.[key]);
  }
  for (const field of fields) {
    const value = config[field.key];
    if (
      field.secretRef && field.type === "text" && field.key.endsWith("Env") &&
      value !== undefined &&
      value !== "" &&
      (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(value))
    ) {
      throw new ValidationError({
        message:
          "Credential references must be environment variable names supported by this connector; never enter a credential value.",
      });
    }
  }
}
