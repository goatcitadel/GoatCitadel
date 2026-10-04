// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readTestbenchEnv, type TestbenchEnv } from "../env";
import {
  GATEWAY_ORIGIN_META_NAME,
  applyGatewayOriginMeta,
  buildTargetHref,
  resolveTargetRequest,
} from "./resolve-target";

const LAUNCHED: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/goatcitadel-usability-testbench",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const NOT_LAUNCHED: TestbenchEnv = {
  sandboxOrigin: undefined,
  sandboxRoot: undefined,
  realOrigin: undefined,
  isProd: false,
};

afterEach(() => {
  document.head.innerHTML = "";
});

describe("readTestbenchEnv", () => {
  it("trims launcher values, drops blanks, and reads PROD", () => {
    expect(
      readTestbenchEnv({
        VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: " http://127.0.0.1:41873 ",
        VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: "   ",
        PROD: true,
      }),
    ).toEqual({
      sandboxOrigin: "http://127.0.0.1:41873",
      sandboxRoot: undefined,
      realOrigin: undefined,
      isProd: true,
    });
  });
});

describe("resolveTargetRequest", () => {
  it("defaults to the sandbox when the launcher supplied one", () => {
    expect(resolveTargetRequest("", LAUNCHED)).toEqual({ requested: "sandbox", origin: "http://127.0.0.1:41873" });
  });

  it("defaults to the real gateway and keeps the client's default origin when nothing was launched", () => {
    expect(resolveTargetRequest("", NOT_LAUNCHED)).toEqual({ requested: "real", origin: undefined });
  });

  it("honours an explicit real target with the launcher's real origin", () => {
    expect(resolveTargetRequest("?target=real", LAUNCHED)).toEqual({
      requested: "real",
      origin: "http://127.0.0.1:8787",
    });
  });

  it("keeps an explicit sandbox request even when no sandbox was launched", () => {
    expect(resolveTargetRequest("?target=sandbox", NOT_LAUNCHED)).toEqual({ requested: "sandbox", origin: undefined });
  });

  it("ignores unknown target values", () => {
    expect(resolveTargetRequest("?target=prod", LAUNCHED).requested).toBe("sandbox");
  });
});

describe("applyGatewayOriginMeta", () => {
  it("replaces any existing gateway-origin meta tag", () => {
    applyGatewayOriginMeta(document, "http://127.0.0.1:1111");
    applyGatewayOriginMeta(document, "http://127.0.0.1:2222");
    const tags = document.querySelectorAll(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.getAttribute("content")).toBe("http://127.0.0.1:2222");
  });

  it("removes the tag when no origin is forced", () => {
    applyGatewayOriginMeta(document, "http://127.0.0.1:1111");
    applyGatewayOriginMeta(document, undefined);
    expect(document.querySelector(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`)).toBeNull();
  });
});

describe("buildTargetHref", () => {
  it("switches the target and keeps other query parameters", () => {
    expect(buildTargetHref("http://127.0.0.1:5173/testbench.html?target=sandbox&x=1", "real")).toBe(
      "http://127.0.0.1:5173/testbench.html?target=real&x=1",
    );
  });
});
