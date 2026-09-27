import { ValidationError, type ChangePlanRequiredAction } from "@goatcitadel/contracts";

export function validatePublicValues(
  action: Extract<ChangePlanRequiredAction, { kind: "public_form" }>,
  values: Readonly<Record<string, string | number | boolean>>,
): void {
  const allowed = new Map(action.fields.map((field) => [field.fieldId, field]));
  for (const [fieldId, value] of Object.entries(values)) {
    const field = allowed.get(fieldId);
    if (!field) throw new ValidationError({ message: `Public form field ${fieldId} is not part of this Change Plan.` });
    if (
      /secret|password|token|credential|api.?key|oauth/iu.test(fieldId) &&
      field.valueSemantic !== "environment_reference"
    ) {
      throw new ValidationError({ message: "Secret-like fields must use the dedicated secure-input flow." });
    }
    if (
      field.valueSemantic === "environment_reference" &&
      (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(value))
    ) {
      throw new ValidationError({ message: `Public form field ${fieldId} must be an environment variable name.` });
    }
    if (typeof value === "string" && (value.length > 4_000 || /[\0]/u.test(value))) {
      throw new ValidationError({ message: `Public form field ${fieldId} is invalid.` });
    }
  }
  for (const field of action.fields) {
    if (field.required && values[field.fieldId] === undefined) {
      throw new ValidationError({ message: `Public form field ${field.fieldId} is required.` });
    }
  }
}
