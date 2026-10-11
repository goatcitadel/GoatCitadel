import { beforeEach, describe, expect, it } from "vitest";

import { ApiRequestError } from "../api/http-internal";
import {
  __resetApprovalOperationAttemptsForTests,
  beginApprovalOperation,
  canReviewApprovalOperation,
  classifyOperationFailure,
  dismissUncertainApprovalOperation,
  releaseApprovalOperationCheck,
  releaseRefusedApprovalOperation,
  updateApprovalOperation,
  useApprovalOperationAttempt,
} from "./scoped-operation-attempts";

const http = (status: number) => new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/api/v1/x", status });

describe("classifyOperationFailure", () => {
  it.each([400, 401, 403, 404, 409, 422])("treats a Gateway %s after dispatch as a definitive refusal", (status) => {
    expect(classifyOperationFailure(http(status))).toBe("refused");
  });

  it.each([408, 429, 500, 502, 503, 504])("keeps a %s uncertain because the write may have landed", (status) => {
    expect(classifyOperationFailure(http(status))).toBe("uncertain");
  });

  it("keeps network, protocol, abort and unknown failures uncertain", () => {
    expect(classifyOperationFailure(new ApiRequestError("Network error", { kind: "network", method: "POST", path: "/api/v1/x" }))).toBe("uncertain");
    expect(classifyOperationFailure(new ApiRequestError("Bad body", { kind: "protocol", method: "POST", path: "/api/v1/x", status: 200 }))).toBe("uncertain");
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(classifyOperationFailure(abort)).toBe("uncertain");
    expect(classifyOperationFailure(new Error("socket closed"))).toBe("uncertain");
    expect(classifyOperationFailure(undefined)).toBe("uncertain");
    expect(classifyOperationFailure({ status: 400 })).toBe("uncertain");
  });
});

describe("attempt release after a refusal", () => {
  beforeEach(() => __resetApprovalOperationAttemptsForTests());

  it("drops a submitted attempt the owner refused so the same revision can be reviewed again", () => {
    const token = beginApprovalOperation("key", "rev-1")!;
    updateApprovalOperation("key", token, "submitted", "sent");
    releaseRefusedApprovalOperation("key", token);
    expect(canReviewApprovalOperation(undefined, "rev-1")).toBe(true);
    expect(beginApprovalOperation("key", "rev-1")).toBeDefined();
  });

  it("ignores a stale token", () => {
    const first = beginApprovalOperation("key", "rev-1")!;
    updateApprovalOperation("key", first, "uncertain", "lost");
    releaseRefusedApprovalOperation("key", Symbol("other"));
    expect(dismissUncertainApprovalOperation("key")).toBe(true);
    expect(releaseApprovalOperationCheck).toBeTypeOf("function");
  });
});

describe("dismissUncertainApprovalOperation", () => {
  beforeEach(() => __resetApprovalOperationAttemptsForTests());

  it("clears only an uncertain attempt and reports whether anything was dismissed", () => {
    expect(dismissUncertainApprovalOperation("missing")).toBe(false);
    const token = beginApprovalOperation("key", "rev-1")!;
    updateApprovalOperation("key", token, "submitted", "sent");
    expect(dismissUncertainApprovalOperation("key")).toBe(false);
    updateApprovalOperation("key", token, "uncertain", "lost");
    expect(dismissUncertainApprovalOperation("key")).toBe(true);
    expect(beginApprovalOperation("key", "rev-1")).toBeDefined();
  });

  it("leaves a resolved attempt alone", () => {
    const token = beginApprovalOperation("key", "rev-1")!;
    updateApprovalOperation("key", token, "resolved", "done");
    expect(dismissUncertainApprovalOperation("key")).toBe(false);
    expect(useApprovalOperationAttempt).toBeTypeOf("function");
  });
});
