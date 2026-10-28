import { z } from "zod";
import {
  CURATED_FS_MUTATION_TOOLS,
  GLOBAL_TOOL_ACCESS_POSTURES,
  OPERATOR_WRITE_ROOT_PRESETS,
  SWITCHABLE_TOOL_GROUP_IDS,
  isOperatorWriteRootLabel,
  isOperatorWriteRootPathText,
} from "@goatcitadel/contracts";

/**
 * Strict request shapes shared by the Settings PATCH route and the Change Plan
 * routes. The settings owner still canonicalizes every folder.
 */
export const operatorWriteRootChangeFields = {
  action: z.enum(["add", "remove"]),
  path: z
    .string()
    .refine(isOperatorWriteRootPathText, "Folder path must be an absolute path without control characters.")
    .optional(),
  preset: z.enum(OPERATOR_WRITE_ROOT_PRESETS).optional(),
  allowDelete: z.boolean().optional(),
  label: z.string().refine(isOperatorWriteRootLabel, "Label must be 1-120 printable characters.").optional(),
} as const;

export function refineOperatorWriteRootChange(
  value: { action: "add" | "remove"; path?: string; preset?: string; allowDelete?: boolean; label?: string },
  ctx: z.RefinementCtx,
): void {
  if ((value.path === undefined) === (value.preset === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of path or preset.", path: ["path"] });
  }
  if (value.action === "remove" && (value.allowDelete !== undefined || value.label !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "allowDelete and label apply only when adding a root.",
      path: ["action"],
    });
  }
}

export const operatorWriteRootChangeSchema = z
  .object(operatorWriteRootChangeFields)
  .strict()
  .superRefine(refineOperatorWriteRootChange);

export const globalToolAccessChangeFields = {
  toolName: z.enum(CURATED_FS_MUTATION_TOOLS),
  posture: z.enum(GLOBAL_TOOL_ACCESS_POSTURES),
} as const;

export const globalToolAccessChangeSchema = z.object(globalToolAccessChangeFields).strict();

/** The plain refusal for Core, or an id that isn't a switchable group. */
export const TOOL_GROUP_REFUSAL = "That tool group can't be switched off.";

/** One switchable tool group per save; Core is not in the enum, so it can never be named. */
export const toolGroupChangeFields = {
  // A missing id keeps zod's own "required" message.
  groupId: z.enum(SWITCHABLE_TOOL_GROUP_IDS, {
    error: (issue) => (issue.input === undefined ? undefined : TOOL_GROUP_REFUSAL),
  }),
  enabled: z.boolean(),
} as const;

export const toolGroupChangeSchema = z.object(toolGroupChangeFields).strict();
