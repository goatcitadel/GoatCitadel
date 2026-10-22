import { describe, expect, it } from "vitest";
import { presentDemoStatus, presentHostOs } from "./settings-vocabulary";

describe("presentDemoStatus (ST-N15)", () => {
  it("words the demo preparation status", () => {
    expect(presentDemoStatus("ready")).toBe("Ready");
    expect(presentDemoStatus("partial")).toBe("Partly prepared");
    expect(presentDemoStatus("not_started")).toBe("Not prepared");
    expect(presentDemoStatus(undefined)).toBe("Not checked");
  });
});

describe("presentHostOs", () => {
  it("names the platform and architecture in plain words", () => {
    expect(presentHostOs({ platform: "win32", arch: "x64" })).toBe("Windows, 64-bit");
    expect(presentHostOs({ platform: "darwin", arch: "arm64" })).toBe("macOS, ARM 64-bit");
    expect(presentHostOs({ platform: "linux", arch: "x64" })).toBe("Linux, 64-bit");
  });

  it("shows unknown tokens as given and says when nothing was reported", () => {
    expect(presentHostOs({ platform: "freebsd", arch: "riscv64" })).toBe("freebsd, riscv64");
    expect(presentHostOs({ platform: "linux", arch: "" })).toBe("Linux");
    expect(presentHostOs({ platform: "constructor", arch: "toString" })).toBe("constructor, toString");
    expect(presentHostOs({})).toBe("Not reported");
  });
});
