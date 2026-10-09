import { beforeEach, expect, it, vi } from "vitest";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { freshReadsActive } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import { settleTrackedAttempt, type TrackedAttempt } from "./mutation-attempt-tracking";

const attempts = vi.hoisted(() => ({ read: vi.fn() }));
// A test can switch the connected installation mid-check; the real capture recorded the installation it used.
const gateway = vi.hoisted(() => ({ override: undefined as string | undefined }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>();
  return { ...original, getGatewayApiBaseUrl: () => gateway.override ?? original.getGatewayApiBaseUrl() };
});
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));

const transport: TrackedAttempt = {
  attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  method: "PATCH",
  routePattern: "/api/v1/settings",
};
const readback = vi.fn(async () => undefined);
beforeEach(() => {
  vi.resetAllMocks();
  gateway.override = undefined;
  readback.mockResolvedValue(undefined);
});

it("settles a committed attempt only after the readback succeeds", async () => {
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  const result = await settleTrackedAttempt(transport, readback, "runtime change");
  expect(attempts.read).toHaveBeenCalledWith(transport.attemptKey, "PATCH", "/api/v1/settings");
  expect(readback).toHaveBeenCalledOnce();
  expect(result).toEqual({
    settled: true,
    message: expect.stringMatching(/recorded this runtime change as processed/),
  });
});

it("settles a released attempt without claiming nothing was applied", async () => {
  attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
  const result = await settleTrackedAttempt(transport, readback, "runtime change");
  expect(result).toEqual({ settled: true, message: expect.stringMatching(/may still have been applied/) });
});

it.each([
  [{ status: "pending", claimExpired: false }, /still running/],
  [{ status: "pending", claimExpired: true }, /expired/],
  [{ status: "absent" }, /no record/],
])("does not settle %o and never reads back", async (record, message) => {
  attempts.read.mockResolvedValue(record);
  const result = await settleTrackedAttempt(transport, readback, "runtime change");
  expect(result).toEqual({ settled: false, message: expect.stringMatching(message) });
  expect(readback).not.toHaveBeenCalled();
});

it.each(["read", "readback"] as const)(
  "does not settle when the %s fails, and shows no Gateway text",
  async (failure) => {
    if (failure === "read") attempts.read.mockRejectedValue(new Error("API error 403: gateway-internal-detail"));
    else {
      attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
      readback.mockRejectedValue(new Error("API error 503: gateway-internal-detail"));
    }
    const result = await settleTrackedAttempt(transport, readback, "runtime change");
    expect(result.settled).toBe(false);
    expect(result.message).toMatch(/check failed/);
    expect(result.message).not.toContain("gateway-internal-detail");
  },
);

it("refuses to check an attempt made against a different Gateway installation", async () => {
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  const result = await settleTrackedAttempt(
    { ...transport, installation: "http://other-gateway.invalid" },
    readback,
    "runtime change",
  );
  expect(result.settled).toBe(false);
  expect(result.message).toMatch(/different Gateway/);
  expect(attempts.read).not.toHaveBeenCalled();
  expect(readback).not.toHaveBeenCalled();
});

it.each(["during the attempt read", "during the readback"])(
  "does not settle when the Gateway connection changes %s",
  async (when) => {
    const installation = getGatewayApiBaseUrl();
    attempts.read.mockImplementation(async () => {
      if (when === "during the attempt read") gateway.override = "http://other-gateway.invalid";
      return { status: "completed", claimExpired: false };
    });
    readback.mockImplementation(async () => {
      gateway.override = "http://other-gateway.invalid";
    });
    const result = await settleTrackedAttempt({ ...transport, installation }, readback, "runtime change");
    expect(result).toEqual({ settled: false, message: expect.stringMatching(/different Gateway/) });
    if (when === "during the attempt read") expect(readback).not.toHaveBeenCalled();
  },
);

it("reads back fresh, never joining an older in-flight read", async () => {
  attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
  let fresh = false;
  readback.mockImplementation(async () => {
    fresh = freshReadsActive();
  });
  await settleTrackedAttempt({ ...transport, installation: getGatewayApiBaseUrl() }, readback, "runtime change");
  expect(fresh).toBe(true);
  expect(freshReadsActive()).toBe(false);
});
