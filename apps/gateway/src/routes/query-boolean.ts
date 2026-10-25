import { z } from "zod";

/**
 * Strict boolean for URL query strings. `z.coerce.boolean()` is unusable here because it turns the
 * string "false" into true. Accepts true/false/1/0 (case-insensitive) and rejects everything else.
 */
export const queryBoolean = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["true", "false", "1", "0"]))
    .transform((value) => value === "true" || value === "1"),
]);
