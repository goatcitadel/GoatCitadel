import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  PolicyViolationError,
  ToolExecutionError,
  ExternalServiceError,
  BudgetExceededError,
  ConfigValidationError,
  GoatError,
  isGoatError,
  PayloadTooLargeError,
} from "./errors.js";

describe("GoatError hierarchy", () => {
  it("NotFoundError with entity+id", () => {
    const err = new NotFoundError({ entity: "AgentProfile", id: "abc123" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GoatError);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("ENTITY_NOT_FOUND");
    expect(err.httpStatus).toBe(404);
    expect(err.message).toBe("AgentProfile abc123 not found");
    expect(err.name).toBe("NotFoundError");
    expect(err.toJSON()).toEqual({
      error: "AgentProfile abc123 not found",
      code: "ENTITY_NOT_FOUND",
      details: { entity: "AgentProfile", id: "abc123" },
    });
  });

  it("NotFoundError with string message", () => {
    const err = new NotFoundError("Session not found");
    expect(err.message).toBe("Session not found");
    expect(err.details).toBeUndefined();
    expect(err.toJSON()).toEqual({ error: "Session not found", code: "ENTITY_NOT_FOUND" });
  });

  it("NotFoundError with entity only (no id)", () => {
    const err = new NotFoundError({ entity: "Workspace" });
    expect(err.message).toBe("Workspace not found");
  });

  it("ValidationError defaults to FIELD_INVALID", () => {
    const err = new ValidationError({ field: "email" });
    expect(err.code).toBe("FIELD_INVALID");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toBe("email is invalid");
  });

  it("ValidationError with FIELD_REQUIRED code", () => {
    const err = new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
    expect(err.code).toBe("FIELD_REQUIRED");
    expect(err.message).toBe("workspaceId is required");
  });

  it("ValidationError with custom message", () => {
    const err = new ValidationError({ message: "slug contains unsupported characters" });
    expect(err.message).toBe("slug contains unsupported characters");
  });

  it("ConflictError defaults to STATE_CONFLICT", () => {
    const err = new ConflictError({ message: "Approval already resolved" });
    expect(err.code).toBe("STATE_CONFLICT");
    expect(err.httpStatus).toBe(409);
  });

  it("ConflictError with ALREADY_EXISTS", () => {
    const err = new ConflictError({ code: "ALREADY_EXISTS", message: "Agent role foo already exists" });
    expect(err.code).toBe("ALREADY_EXISTS");
  });

  it("ConflictError with WRITE_CONFLICT", () => {
    const err = new ConflictError({ code: "WRITE_CONFLICT", message: "chat turn conflict" });
    expect(err.code).toBe("WRITE_CONFLICT");
  });

  it("PolicyViolationError defaults to POLICY_BLOCKED", () => {
    const err = new PolicyViolationError({ message: "Tool not in allowed list" });
    expect(err.code).toBe("POLICY_BLOCKED");
    expect(err.httpStatus).toBe(403);
  });

  it("PolicyViolationError with PATH_OUTSIDE_JAIL", () => {
    const err = new PolicyViolationError({ code: "PATH_OUTSIDE_JAIL", message: "Path is outside workspace" });
    expect(err.code).toBe("PATH_OUTSIDE_JAIL");
  });

  it("ToolExecutionError defaults to TOOL_EXEC_FAILED", () => {
    const err = new ToolExecutionError({ message: "shell.exec timed out" });
    expect(err.code).toBe("TOOL_EXEC_FAILED");
    expect(err.httpStatus).toBe(500);
  });

  it("ExternalServiceError", () => {
    const err = new ExternalServiceError("gmail.send failed (429)", { service: "gmail" });
    expect(err.code).toBe("EXTERNAL_SERVICE_FAILED");
    expect(err.httpStatus).toBe(502);
    expect(err.toJSON().details).toEqual({ service: "gmail" });
  });

  it("BudgetExceededError", () => {
    const err = new BudgetExceededError("Turn budget exceeded", { budgetMs: 40000 });
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.httpStatus).toBe(429);
  });

  it("PayloadTooLargeError", () => {
    const err = new PayloadTooLargeError("Upload is too large", { limitBytes: 10 });
    expect(err.code).toBe("PAYLOAD_TOO_LARGE");
    expect(err.httpStatus).toBe(413);
    expect(err.toJSON()).toEqual({
      error: "Upload is too large",
      code: "PAYLOAD_TOO_LARGE",
      details: { limitBytes: 10 },
    });
  });

  it("ConfigValidationError formats issues", () => {
    const err = new ConfigValidationError("config/tool-policy.json", [
      { path: "sandbox.writeJailRoots", message: "Expected array, received string" },
      { path: "tools.profile", message: "Invalid enum value" },
    ]);
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.httpStatus).toBe(500);
    expect(err.issues).toHaveLength(2);
    expect(err.message).toContain("config/tool-policy.json");
    expect(err.message).toContain("sandbox.writeJailRoots");
  });

  it("isGoatError type guard", () => {
    expect(isGoatError(new NotFoundError("x"))).toBe(true);
    expect(isGoatError(new BudgetExceededError("x"))).toBe(true);
    expect(isGoatError(new Error("x"))).toBe(false);
    expect(isGoatError("string")).toBe(false);
    expect(isGoatError(null)).toBe(false);
  });

  it("preserves stack trace", () => {
    const err = new NotFoundError("test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("NotFoundError");
  });

  it("toJSON omits details when undefined", () => {
    const err = new NotFoundError("bare message");
    const json = err.toJSON();
    expect("details" in json).toBe(false);
  });
});
