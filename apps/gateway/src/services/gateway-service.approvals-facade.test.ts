import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

vi.mock("./approval-remote-token-service.js", () => ({
  consumeRemoteActionToken: vi.fn(() => ({ tokenId: "token-consumed", state: "consumed" })),
  consumeRemoteActionTokenById: vi.fn(() => ({ tokenId: "token-by-id-consumed", state: "consumed" })),
}));

import { GatewayService } from "./gateway-service.js";
import * as approvalRemoteTokenService from "./approval-remote-token-service.js";

function createGatewayFacadeHarness(): GatewayService {
  return Object.create(GatewayService.prototype) as GatewayService;
}

describe("GatewayService approvals facade delegation", () => {
  it("forwards consumeRemoteActionToken to the extracted remote-token service", () => {
    const gateway = createGatewayFacadeHarness();

    expect(GatewayService.prototype.consumeRemoteActionToken.call(gateway, "raw-token", "approval.resolve")).toEqual({
      tokenId: "token-consumed",
      state: "consumed",
    });

    expect(approvalRemoteTokenService.consumeRemoteActionToken).toHaveBeenCalledWith(
      gateway,
      "raw-token",
      "approval.resolve",
    );
  });

  it("forwards consumeRemoteActionTokenById to the extracted remote-token service", () => {
    const gateway = createGatewayFacadeHarness();

    expect(GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, "token-1", "approval.resolve")).toEqual({
      tokenId: "token-by-id-consumed",
      state: "consumed",
    });

    expect(approvalRemoteTokenService.consumeRemoteActionTokenById).toHaveBeenCalledWith(
      gateway,
      "token-1",
      "approval.resolve",
    );
  });
});
