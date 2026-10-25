import { describe, expect, it } from "vitest";
import { CAPABILITY_CONNECTOR_GROUP_ORDER } from "./capability-connectors.js";

describe("capability connector list contract", () => {
  it("orders groups connected, on this device, available, turned off", () => {
    expect(CAPABILITY_CONNECTOR_GROUP_ORDER).toEqual(["connected", "on_this_device", "available", "turned_off"]);
  });
});
