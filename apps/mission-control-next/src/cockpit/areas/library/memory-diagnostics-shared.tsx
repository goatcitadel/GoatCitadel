import type { ReactNode } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { useMemoryOperatorSnapshot } from "@goatcitadel/mission-control-shared/hooks/useMemoryOperatorSnapshot";
import { TimeText } from "../../ui/TimeText";

/** A memory operation the operator reviews in the confirmation dialog before it runs. */
export type Review = {
  label: string;
  consequence: string;
  revision: string;
  values?: Record<string, unknown>;
  maintenance?: boolean;
  check: () => Promise<void>;
  apply: () => Promise<string>;
};

/** Opens the review dialog for one memory operation. */
export type RequestReview = (review: Review) => void;

/** The canonical memory operator snapshot the diagnostics views read. */
export type MemorySnapshot = NonNullable<ReturnType<typeof useMemoryOperatorSnapshot>["data"]>;

export function readableValues(value: unknown): string {
  if (Array.isArray(value)) return value.map(readableValues).join(", ");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, entry]) => `${key.replace(/([A-Z])/g, " $1")}: ${readableValues(entry)}`)
      .join("; ");
  return value == null ? "Default" : String(value);
}

export const stamp = (value?: string) => (value ? <TimeText value={value} /> : "Not recorded");

/** One labelled fact in a diagnostics record. */
export const Fact = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-wrap gap-x-2">
    <dt className="text-fg-secondary">{term}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
);

export const FACTS = "grid min-w-0 grid-cols-1 gap-1 text-sm";

export function same(actual: unknown, reviewed: unknown) {
  if (canonicalJsonString(actual) !== canonicalJsonString(reviewed))
    throw new Error("The reviewed record changed. Refresh and review the current record.");
}
