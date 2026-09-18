import { describe, expect, it } from "vitest";
import { normalizeRemoteWorkerInstallationSubmission as submission, normalizeRemoteWorkerInstallationReply as reply } from "./remote-worker-installation-rpc.js";
const input = { kind: "runtime.install.session", sessionId: "ab".repeat(32), sequence: 1, action: "prepare", payloadHex: "7b7d" };
describe("bounded installation session wire", () => {
  it("snapshots exact request and response fields", () => {
    expect(submission(input)).toEqual(input); expect(Object.isFrozen(submission(input))).toBe(true);
    const output = { sessionId: input.sessionId, sequence: 1, event: "challenge", payloadHex: "7b7d" };
    expect(reply(output)).toEqual(output); expect(Object.isFrozen(reply(output))).toBe(true);
  });
  it.each([{ sessionId: "00".repeat(32) }, { sequence: 0 }, { sequence: 300001 }, { sequence: 1.5 },
    { action: "approve" }, { payloadHex: "A0" }, { payloadHex: "f" }, { payloadHex: "ff".repeat(100000) },
    { controllerEnrollment: {} }, { kind: "runtime.install.retain" }])("refuses malformed or overbounded input %j", patch => {
    expect(() => submission({ ...input, ...patch })).toThrow();
  });
  it("does not invoke accessors or accept worker-created authority fields", () => {
    let read = false;
    expect(() => submission({ ...input, get action() { read = true; return "prepare"; } })).toThrow();
    expect(read).toBe(false);
    expect(() => reply({ sessionId: input.sessionId, sequence: 1, event: "approved", payloadHex: "" })).toThrow();
  });
});
