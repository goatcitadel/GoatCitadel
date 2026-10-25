import { ValidationError } from "@goatcitadel/contracts";
import { isProxy } from "node:util/types";

/** Input guards for deterministic detached approvals: canonical identifiers and plain, finite JSON records. */
export function assertCanonicalApprovalIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
}

export function assertSafePlainApprovalRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  assertSafeApprovalJsonValue(value, field, new Set<object>());
}

function assertSafeApprovalJsonValue(value: unknown, field: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype) || seen.has(value)) {
    throw new ValidationError({ code: "FIELD_INVALID", field });
  }
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new ValidationError({ code: "FIELD_INVALID", field });
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (isArray) {
      const length = descriptors.length?.value;
      const elementKeys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        elementKeys.length !== length ||
        elementKeys.some((key, index) => key !== String(index))
      ) {
        throw new ValidationError({ code: "FIELD_INVALID", field });
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new ValidationError({ code: "FIELD_INVALID", field });
      }
      assertSafeApprovalJsonValue(descriptor.value, field, seen);
    }
  } finally {
    seen.delete(value);
  }
}
