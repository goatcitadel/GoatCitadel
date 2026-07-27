import { describe, expect, it } from "vitest";
import { presentNativeRouteError } from "./native-route-errors";

describe("presentNativeRouteError", () => {
  it("turns fail-closed 403 responses into an operator authentication state", () => {
    const result = presentNativeRouteError("API error 403: this route requires a specific authenticated operator", {
      resourceLabel: "Saved Boards",
    });

    expect(result).toMatchObject({
      category: "authentication-required",
      title: "Operator authentication required",
    });
    expect(result.description).not.toContain("API error 403");
    expect(result.technicalDetail).toContain("API error 403");
  });

  it("keeps fetch failures out of the primary Runtime message", () => {
    const result = presentNativeRouteError("fetch failed", {
      resourceLabel: "Runtime settings",
      unavailableDescription: "Runtime settings could not be read from the Gateway.",
    });

    expect(result).toMatchObject({
      category: "gateway-unavailable",
      title: "Runtime settings unavailable",
      description: "Runtime settings could not be read from the Gateway.",
      technicalDetail: "fetch failed",
    });
    expect(result.description).not.toContain("fetch failed");
  });
});
