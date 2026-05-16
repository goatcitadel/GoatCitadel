import { z } from "zod";

/**
 * Validated gateway environment variables.
 *
 * Parsed once at import time. If a required variable is missing or invalid,
 * the process exits with a clear error message before Fastify starts.
 */

const GatewayEnvSchema = z.object({
  /** Host address to bind to. Defaults to 127.0.0.1 (loopback). */
  GATEWAY_HOST: z.string().default("127.0.0.1"),

  /** Port to listen on. Must be a valid port number. */
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),

  /** Node environment. */
  NODE_ENV: z.string().optional(),

  /** Comma-separated list of allowed CORS origins. */
  GOATCITADEL_ALLOWED_ORIGINS: z.string().optional(),

  /** Enable Tailnet dev origins (auto-enabled in non-production). */
  GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: z.string().optional(),

  /** Enable rate limiting. Defaults to true. */
  GOATCITADEL_RATE_LIMIT_ENABLED: z.string().optional(),
  GOATCITADEL_RATE_LIMIT_MAX_GENERAL: z.coerce.number().int().positive().optional(),
  GOATCITADEL_RATE_LIMIT_MAX_MUTATION: z.coerce.number().int().positive().optional(),
  GOATCITADEL_RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().optional(),
  GOATCITADEL_RATE_LIMIT_MAX_SSE_CONNECT: z.coerce.number().int().positive().optional(),

  /** Allow unauthenticated network binding (dangerous). */
  GOATCITADEL_ALLOW_UNAUTH_NETWORK: z.string().optional(),

  /** Log level for structured logger. */
  GOATCITADEL_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),

  /** Verbose logging toggle. */
  GOATCITADEL_VERBOSE: z.string().optional(),

  /** Terminal task label. */
  GOATCITADEL_TERMINAL_TASK: z.string().optional(),

  /** Custom Vite allowed hosts. */
  GOATCITADEL_VITE_ALLOWED_HOSTS: z.string().optional(),

  /** Disable streaming delta coalescing (set to "true" to opt out). */
  GOATCITADEL_STREAM_COALESCE_OFF: z.union([z.literal("true"), z.literal("false")]).optional(),
});

export type GatewayEnv = z.infer<typeof GatewayEnvSchema>;

function parseGatewayEnv(): GatewayEnv {
  const result = GatewayEnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    process.stderr.write(`[goatcitadel] Invalid environment configuration:\n${issues.join("\n")}\n`);
    process.exit(1);
  }
  return result.data;
}

/** Validated environment variables — safe to use without further null checks. */
export const env = parseGatewayEnv();
