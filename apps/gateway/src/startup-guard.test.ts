import { describe, expect, it } from "vitest";
import {
  INSECURE_LOCAL_ONLY_OVERRIDE_ENV,
  isLoopbackHost,
  resolveAllowUnauthNetwork,
  resolveWarnUnauthNonLoopback,
  shouldWarnUnauthNonLoopbackBind,
} from "./startup-guard.js";

describe("startup guard helpers", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("parses boolean env-style values", () => {
    expect(resolveWarnUnauthNonLoopback(undefined)).toBe(true);
    expect(resolveWarnUnauthNonLoopback("false")).toBe(false);
    expect(resolveAllowUnauthNetwork(undefined)).toBe(false);
    expect(resolveAllowUnauthNetwork("true")).toBe(true);
    expect(INSECURE_LOCAL_ONLY_OVERRIDE_ENV).toBe("GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY");
  });

  it("requires auth for non-loopback bind", () => {
    expect(
      shouldWarnUnauthNonLoopbackBind("0.0.0.0", {
        mode: "none",
        allowLoopbackBypass: false,
        token: { queryParam: "access_token" },
        basic: {},
      }),
    ).toBe(true);

    expect(
      shouldWarnUnauthNonLoopbackBind("0.0.0.0", {
        mode: "token",
        allowLoopbackBypass: false,
        token: { value: "tok", queryParam: "access_token" },
        basic: {},
      }),
    ).toBe(false);

    expect(
      shouldWarnUnauthNonLoopbackBind("127.0.0.1", {
        mode: "none",
        allowLoopbackBypass: false,
        token: { queryParam: "access_token" },
        basic: {},
      }),
    ).toBe(false);
  });
});
