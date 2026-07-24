import { describe, expect, it } from "vitest";
import { resolveWorkspacePathBridgeRuntimeConfig } from "./workspace-path-bridge-config.js";

describe("workspace path bridge runtime config", () => {
  it.each([
    [{}, {}],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "" }, {}],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "msys" }, { pathSource: { flavor: "msys" } }],
    [
      {
        GOATCITADEL_WORKSPACE_PATH_SOURCE: "wsl",
        GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO: "Ubuntu-24.04",
      },
      { pathSource: { flavor: "wsl", distro: "Ubuntu-24.04" } },
    ],
  ] as const)("accepts server-owned source config %#", (environment, expected) => {
    expect(resolveWorkspacePathBridgeRuntimeConfig(environment, "windows")).toEqual(expected);
  });

  it.each([
    [{ GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO: "Ubuntu" }, "requires"],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "msys", GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO: "Ubuntu" }, "forbidden"],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "wsl" }, "requires"],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "wsl", GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO: "../Ubuntu" }, "requires"],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "WSL" }, "must be unset, msys, or wsl"],
    [{ GOATCITADEL_WORKSPACE_PATH_SOURCE: "auto" }, "must be unset, msys, or wsl"],
  ] as const)("rejects invalid source config %#", (environment, message) => {
    expect(() => resolveWorkspacePathBridgeRuntimeConfig(environment, "windows")).toThrow(message);
  });

  it("keeps MSYS and WSL source translation Windows-host-only", () => {
    expect(() =>
      resolveWorkspacePathBridgeRuntimeConfig({ GOATCITADEL_WORKSPACE_PATH_SOURCE: "msys" }, "posix"),
    ).toThrow("Windows-host-only");
    expect(resolveWorkspacePathBridgeRuntimeConfig({}, "posix")).toEqual({});
  });
});
