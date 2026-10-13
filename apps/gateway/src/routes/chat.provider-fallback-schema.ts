import { z } from "zod";

/** A preference is not a provider-dispatch authorization. */
export const providerFallbackPreferenceSchema = z
  .object({
    providerId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32)),
    model: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32)),
    allowLocalToCloud: z.boolean(),
  })
  .strict();
