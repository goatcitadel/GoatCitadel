import { describe, expect, it } from "vitest";
import { isSuspiciousEncodedPath } from "./path-guard.js";

describe("gateway encoded-path guard", () => {
  it("accepts normal API paths", () => {
    expect(isSuspiciousEncodedPath("/api/v1/sessions?limit=50")).toBe(false);
    expect(isSuspiciousEncodedPath("/health")).toBe(false);
  });

  it("accepts colon-delimited opaque IDs only in exact durable watcher control segments", () => {
    expect(
      isSuspiciousEncodedPath("/api/v1/durable/runs/parent-run/background-tasks/delegation-child%3Astep-1/control"),
    ).toBe(false);
    expect(isSuspiciousEncodedPath("/api/v1/durable/child-watchers/orchestration-child%3Arun-1%3Aphase-1/detach")).toBe(
      false,
    );
    expect(isSuspiciousEncodedPath("/api/v1/durable/runs/parent%3Aads/background-tasks/watcher/control")).toBe(false);
    expect(isSuspiciousEncodedPath("/api/v1/other/delegation-child%3Astep-1/control")).toBe(true);
  });

  it("allows native durable run keys only in owned database route parameters", () => {
    for (const id of ["autonomous-delivery:run_cron_chat_123", "autonomous-delivery%3Arun_cron_chat_123"]) {
      for (const suffix of [
        "",
        "/checkpoints",
        "/timeline",
        "/pause",
        "/resume",
        "/cancel",
        "/retry",
        "/events/wake",
      ]) {
        expect(isSuspiciousEncodedPath(`/api/v1/durable/runs/${id}${suffix}`)).toBe(false);
      }
      expect(isSuspiciousEncodedPath(`/api/v1/files/${id}`)).toBe(true);
      expect(isSuspiciousEncodedPath(`/api/v1/durable/runs/${id}/unowned-route`)).toBe(true);
    }
    for (const id of ["CON", "file.txt::$DATA", "x%2Fy", "x%5Cy", "%252e%252e", "x%00y"]) {
      expect(isSuspiciousEncodedPath(`/api/v1/durable/runs/${id}/checkpoints`)).toBe(true);
    }
  });

  it("rejects encoded traversal-like sequences", () => {
    expect(isSuspiciousEncodedPath("/api/v1/%2e%2e/secrets")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/%252e%252e/secrets")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/%25252e%25252e/secrets")).toBe(true);
  });

  it("rejects encoded slash/backslash segments", () => {
    expect(isSuspiciousEncodedPath("/api/v1/channels/%2Ffoo/inbound")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/channels/%5Cfoo/inbound")).toBe(true);
  });

  it("rejects malformed encoded paths", () => {
    expect(isSuspiciousEncodedPath("/api/v1/%zz/inbound")).toBe(true);
  });

  it("rejects literal or decoded null bytes", () => {
    expect(isSuspiciousEncodedPath("/api/v1/file\u0000.txt")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/file%00.txt")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/file%2500.txt")).toBe(true);
  });

  it("rejects Windows UNC, ADS, and reserved-device path segments", () => {
    expect(isSuspiciousEncodedPath("//server/share/secrets.txt")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/file.txt::$DATA")).toBe(true);
    expect(isSuspiciousEncodedPath("/api/v1/CON/logs")).toBe(true);
    expect(isSuspiciousEncodedPath("/C:/Windows/System32/drivers/etc/hosts")).toBe(true);
  });
});
