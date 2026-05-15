import { describe, expect, it } from "vitest";
import { gatewayPlugin as storageGatewayPlugin } from "./storage.js";
import { gatewayPlugin as sqliteGatewayPlugin } from "./sqlite.js";

describe("sqlite plugin compatibility export", () => {
  it("re-exports the storage gateway plugin for legacy imports", () => {
    expect(sqliteGatewayPlugin).toBe(storageGatewayPlugin);
  });
});
