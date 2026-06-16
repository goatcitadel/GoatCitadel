import { describe, it, expect } from "vitest";
import { routeModelForSensitivity } from "./citadel-model-routing.js";

describe("routeModelForSensitivity", () => {
  it('maps "public" to "any_approved"', () => {
    expect(routeModelForSensitivity("public")).toBe("any_approved");
  });

  it('maps "internal" to "approved_cloud_or_local"', () => {
    expect(routeModelForSensitivity("internal")).toBe("approved_cloud_or_local");
  });

  it('maps "private" to "cloud_with_approval"', () => {
    expect(routeModelForSensitivity("private")).toBe("cloud_with_approval");
  });

  it('maps "sensitive" to "prefer_local"', () => {
    expect(routeModelForSensitivity("sensitive")).toBe("prefer_local");
  });

  it('maps "restricted" to "local_only"', () => {
    expect(routeModelForSensitivity("restricted")).toBe("local_only");
  });

  it('maps "secret" to "never_send"', () => {
    expect(routeModelForSensitivity("secret")).toBe("never_send");
  });
});
