import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readGatewayVersion } from "./capability-plugins-composition.js";

describe("readGatewayVersion", () => {
  it("reads the Gateway package's own version", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };
    expect(manifest.name).toBe("@goatcitadel/gateway");
    expect(readGatewayVersion()).toBe(manifest.version);
  });

  it("reads it once from the package file two folders up, as from src and from dist", () => {
    const asked: string[] = [];
    const version = readGatewayVersion((specifier) => {
      asked.push(specifier);
      return { version: "2.3.0-beta.4+build.7" };
    });
    expect(version).toBe("2.3.0-beta.4+build.7");
    expect(asked).toEqual(["../../package.json"]);
  });

  it("refuses a version that can't name a review key, rather than making one up", () => {
    for (const manifest of [{}, { version: "" }, { version: "1.0 beta" }, { version: "x".repeat(65) }, undefined]) {
      expect(() => readGatewayVersion(() => manifest), JSON.stringify(manifest)).toThrow(
        "The Gateway package's version can't name a plugin skill's review key.",
      );
    }
  });
});
