import { describe, expect, it } from "vitest";
import { ShellOutputCapture } from "./shell-output-capture.js";

describe("ShellOutputCapture", () => {
  it("reassembles a multibyte character split across incoming chunks", () => {
    const capture = new ShellOutputCapture(32);
    const output = Buffer.from("first 🌿 last");
    capture.append(output.subarray(0, 8));
    capture.append(output.subarray(8));
    expect(capture.finish()).toEqual({ head: "first 🌿 last", tail: "", omittedBytes: 0 });
  });

  it.each([1, 13, 100])("retains the same first and last complete lines with %i-byte chunks", (chunkSize) => {
    const capture = new ShellOutputCapture(48);
    const head = "started 🌿\n";
    const tail = "finished 🍂\n";
    const output = Buffer.from(head + "x".repeat(97) + "\n" + tail);
    for (let offset = 0; offset < output.length; offset += chunkSize) {
      capture.append(output.subarray(offset, offset + chunkSize));
    }
    expect(capture.finish()).toEqual({ head, tail, omittedBytes: 98 });
  });
});
