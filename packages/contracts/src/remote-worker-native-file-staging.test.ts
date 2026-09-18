import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerNativeFileStaging as normalize } from "./remote-worker-native-file-staging.js";

const fixture = () => ({ paths: ["report.txt", "nested/result.json"], maximumFileBytes: 1024, maximumTotalBytes: 2048 });
describe("native local file collection policy", () => {
  it("copies and freezes explicit selections without granting disclosure", () => {
    const input = fixture(), result = normalize(input);
    input.paths[0] = "changed.txt";
    expect(result.paths).toEqual(["report.txt", "nested/result.json"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.paths)).toBe(true);
    expect(Object.keys(result)).toEqual(["paths", "maximumFileBytes", "maximumTotalBytes"]);
  });
  it.each(["../file", "/file", "C:/file", "a\\b", "a//b", "a/./b", "a:", "a*", "a?", "a|b", "CON", "conin$", "conout$.txt", "a\u0000b", "a\ud800", "a/", "a.", " a", "a ", "x".repeat(129)])("refuses unsafe selection %j", path => {
    expect(() => normalize({ ...fixture(), paths: [path] })).toThrow();
  });
  it("refuses duplicate Windows names and count or byte limit violations", () => {
    for (const paths of [[], ["report.txt", "REPORT.TXT"], Array.from({ length: 65 }, (_, i) => `file${i}`), [Array(34).fill("a").join("/")]])
      expect(() => normalize({ ...fixture(), paths })).toThrow();
    for (const maximumFileBytes of [0, -1, 1.5, 1048577, NaN, Infinity])
      expect(() => normalize({ ...fixture(), maximumFileBytes })).toThrow();
    for (const maximumTotalBytes of [0, 67108865, "2048"])
      expect(() => normalize({ ...fixture(), maximumTotalBytes })).toThrow();
  });
  it("refuses extra fields, sparse arrays and getters without invoking them", () => {
    let calls = 0;
    const getter = { ...fixture(), get paths() { ++calls; return ["file"]; } };
    const paths = ["file"];
    Object.defineProperty(paths, "0", { enumerable: true, get() { ++calls; return "file"; } });
    for (const input of [getter, { ...fixture(), paths }, { ...fixture(), paths: new Array(1) }, { ...fixture(), approved: true }])
      expect(() => normalize(input)).toThrow();
    expect(calls).toBe(0);
  });
});
