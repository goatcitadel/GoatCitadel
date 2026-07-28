import {
  CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH,
  CHAT_ROUTED_CONTEXT_MAX_REFS,
  CHAT_ROUTED_CONTEXT_CONTROL_PATTERN,
  CHAT_ROUTED_CONTEXT_REF_PATTERN,
  type ChatRoutedContextKind,
} from "@goatcitadel/contracts";
import { z } from "zod";

// HX-407 C1: the three reviewed routed-context kinds. Refs stay identifiers-only
// at this boundary — the server-side resolver (chat-routed-context-service) owns
// every content lookup and freezes the byte-exact snapshot; the strict object
// below rejects any content-bearing field. A future contract kind must be
// deliberately admitted here after review — this gate never auto-widens.
const CHAT_ROUTED_CONTEXT_KIND_VALUES = [
  "attachment",
  "memory_item",
  "external_attachment",
  "personal_note",
  "generated_artifact",
] as const satisfies readonly ChatRoutedContextKind[];

const routedContextRefSchema = z
  .object({
    kind: z.enum(CHAT_ROUTED_CONTEXT_KIND_VALUES),
    ref: z
      .string()
      .min(1)
      .max(CHAT_ROUTED_CONTEXT_MAX_REF_LENGTH)
      .regex(CHAT_ROUTED_CONTEXT_REF_PATTERN, "ref contains unsupported characters")
      .refine((value) => value === value.trim(), "ref must not contain surrounding whitespace"),
    label: z
      .string()
      .min(1)
      .max(CHAT_ROUTED_CONTEXT_MAX_LABEL_LENGTH)
      .refine((value) => value === value.trim(), "label must not contain surrounding whitespace")
      .refine((value) => !CHAT_ROUTED_CONTEXT_CONTROL_PATTERN.test(value), "label contains control characters")
      .optional(),
  })
  .strict();

export const routedContextRefsSchema = z
  .array(routedContextRefSchema)
  .min(1)
  .max(CHAT_ROUTED_CONTEXT_MAX_REFS)
  .superRefine((refs, context) => {
    const seen = new Set<string>();
    refs.forEach((entry, index) => {
      const key = `${entry.kind}\u0000${entry.ref}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "contextRefs must not contain duplicate sources",
          path: [index],
        });
      }
      seen.add(key);
    });
  });
