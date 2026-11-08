import type { ChangePlanRequiredAction } from "@goatcitadel/contracts";
export function secureFields(action: Extract<ChangePlanRequiredAction, { kind: "secure_input" }>) {
  return action.fields?.length ? action.fields : [{ fieldId: "credential", label: "Credential", required: true }];
}
