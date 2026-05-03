/**
 * Centralized error type hierarchy for GoatCitadel.
 *
 * Every subclass carries a machine-readable `code`, a suggested `httpStatus`,
 * and an optional `details` bag for structured context.  The `toJSON()` method
 * produces the wire format used by API responses and SSE error chunks.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type GoatErrorCode =
  | "ENTITY_NOT_FOUND"
  | "FIELD_REQUIRED"
  | "FIELD_INVALID"
  | "ALREADY_EXISTS"
  | "STATE_CONFLICT"
  | "WRITE_CONFLICT"
  | "POLICY_BLOCKED"
  | "PATH_OUTSIDE_JAIL"
  | "HOST_NOT_ALLOWED"
  | "TOOL_UNSUPPORTED"
  | "TOOL_EXEC_FAILED"
  | "TOOL_MISSING_CREDENTIAL"
  | "EXTERNAL_SERVICE_FAILED"
  | "BUDGET_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "CONFIG_INVALID"
  | "SECRET_STORE_UNAVAILABLE"
  | "TURN_CANCELLED";

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class GoatError extends Error {
  abstract readonly code: GoatErrorCode;
  abstract readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }

  toJSON(): { error: string; code: GoatErrorCode; details?: Record<string, unknown> } {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Concrete subclasses
// ---------------------------------------------------------------------------

export class NotFoundError extends GoatError {
  readonly code = "ENTITY_NOT_FOUND" as const;
  readonly httpStatus = 404;

  constructor(opts: { entity: string; id?: string } | string) {
    const msg =
      typeof opts === "string" ? opts : opts.id ? `${opts.entity} ${opts.id} not found` : `${opts.entity} not found`;
    const details = typeof opts === "string" ? undefined : opts;
    super(msg, details);
  }
}

export class ValidationError extends GoatError {
  readonly code: "FIELD_REQUIRED" | "FIELD_INVALID";
  readonly httpStatus = 400;

  constructor(opts: { code?: "FIELD_REQUIRED" | "FIELD_INVALID"; field?: string; message?: string }) {
    const code = opts.code ?? "FIELD_INVALID";
    const msg =
      opts.message ??
      (opts.field ? `${opts.field} is ${code === "FIELD_REQUIRED" ? "required" : "invalid"}` : "Validation failed");
    super(msg, opts.field ? { field: opts.field } : undefined);
    this.code = code;
  }
}

export class ConflictError extends GoatError {
  readonly code: "ALREADY_EXISTS" | "STATE_CONFLICT" | "WRITE_CONFLICT";
  readonly httpStatus = 409;

  constructor(opts: {
    code?: "ALREADY_EXISTS" | "STATE_CONFLICT" | "WRITE_CONFLICT";
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message, opts.details);
    this.code = opts.code ?? "STATE_CONFLICT";
  }
}

export class PolicyViolationError extends GoatError {
  readonly code: "POLICY_BLOCKED" | "PATH_OUTSIDE_JAIL" | "HOST_NOT_ALLOWED";
  readonly httpStatus = 403;

  constructor(opts: {
    code?: "POLICY_BLOCKED" | "PATH_OUTSIDE_JAIL" | "HOST_NOT_ALLOWED";
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message, opts.details);
    this.code = opts.code ?? "POLICY_BLOCKED";
  }
}

export class ToolExecutionError extends GoatError {
  readonly code: "TOOL_EXEC_FAILED" | "TOOL_UNSUPPORTED" | "TOOL_MISSING_CREDENTIAL";
  readonly httpStatus = 500;

  constructor(opts: {
    code?: "TOOL_EXEC_FAILED" | "TOOL_UNSUPPORTED" | "TOOL_MISSING_CREDENTIAL";
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(opts.message, opts.details);
    this.code = opts.code ?? "TOOL_EXEC_FAILED";
  }
}

export class ExternalServiceError extends GoatError {
  readonly code = "EXTERNAL_SERVICE_FAILED" as const;
  readonly httpStatus = 502;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class BudgetExceededError extends GoatError {
  readonly code = "BUDGET_EXCEEDED" as const;
  readonly httpStatus = 429;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class PayloadTooLargeError extends GoatError {
  readonly code = "PAYLOAD_TOO_LARGE" as const;
  readonly httpStatus = 413;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class ConfigValidationError extends GoatError {
  readonly code = "CONFIG_INVALID" as const;
  readonly httpStatus = 500;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(filePath: string, issues: ReadonlyArray<{ path: string; message: string }>) {
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    super(`Config validation failed for ${filePath}:\n${summary}`, { filePath });
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isGoatError(error: unknown): error is GoatError {
  return error instanceof GoatError;
}
