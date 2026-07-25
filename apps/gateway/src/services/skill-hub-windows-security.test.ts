import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NodeSkillHubWindowsSecurity,
  SkillHubWindowsSecurityError,
  type SkillHubWindowsSecurityProtocol,
} from "./skill-hub-windows-security.js";

describe("NodeSkillHubWindowsSecurity", () => {
  it("passes the required signal through native reparse and ACL protocol operations", async () => {
    const signal = new AbortController().signal;
    const request = vi.fn<SkillHubWindowsSecurityProtocol["request"]>(async (operation) =>
      operation === "attributes" ? "1024" : "S-1-5-21-1",
    );
    const security = new NodeSkillHubWindowsSecurity({ request });
    const target = path.resolve("skill-hub-security-fixture");

    await expect(security.inspectReparsePoint(target, signal)).resolves.toBe(true);
    await expect(security.applyOwnerOnlyAcl(target, "directory", signal)).resolves.toEqual({
      ownerSid: "S-1-5-21-1",
    });
    expect(request).toHaveBeenNthCalledWith(1, "attributes", target, "file", signal);
    expect(request).toHaveBeenNthCalledWith(2, "acl", target, "directory", signal);
  });

  it("fails closed with generic errors for cancellation, protocol failure, and malformed native output", async () => {
    const target = path.resolve("skill-hub-security-sensitive-name");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      new NodeSkillHubWindowsSecurity({ request: vi.fn() }).inspectReparsePoint(target, aborted.signal),
    ).rejects.toMatchObject({ code: "cancelled" });

    for (const protocol of [
      { request: vi.fn(async () => "not-an-attribute") },
      { request: vi.fn(async () => Promise.reject(new Error(`secret path: ${target}`))) },
    ] satisfies SkillHubWindowsSecurityProtocol[]) {
      try {
        await new NodeSkillHubWindowsSecurity(protocol).inspectReparsePoint(target, new AbortController().signal);
        throw new Error("Expected native security failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(SkillHubWindowsSecurityError);
        expect((error as Error).message).not.toContain(target);
      }
    }
  });
});
