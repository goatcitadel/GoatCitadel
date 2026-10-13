import { z } from "zod";

/** A preference is not a provider-dispatch authorization. */
export const providerFallbackPreferenceSchema = z
  .object({
    providerId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f]+$/u),
    model: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .regex(/^[^\u0000-\u001f]+$/u),
    allowLocalToCloud: z.boolean(),
  })
  .strict();
