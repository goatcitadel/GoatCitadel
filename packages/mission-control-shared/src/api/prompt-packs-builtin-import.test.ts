import { beforeEach, describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request }));
import { importBuiltinPromptPack, importBuiltinPromptPackIfAbsent } from "./prompt-packs.js";

beforeEach(() => request.mockReset());
describe("guarded built-in import transport", () => {
  it("uses the distinct guarded path and exact review revision", async () => {
    const input = { expectedDefinitionRevision: "a".repeat(64) };
    const receipt = { importReceipt: { operation: "created" } };
    request.mockResolvedValueOnce(receipt);
    expect(await importBuiltinPromptPackIfAbsent("key/with spaces", input)).toBe(receipt);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/prompt-packs/builtins/key%2Fwith%20spaces/import-if-absent",
      { method: "POST", body: JSON.stringify(input) },
    );
  });
  it("never falls back to replacement when an older Gateway lacks the guarded route", async () => {
    const missing = Object.assign(new Error("Not found"), { status: 404 });
    request.mockRejectedValueOnce(missing);
    await expect(
      importBuiltinPromptPackIfAbsent("security-red-team-v6", { expectedDefinitionRevision: "a".repeat(64) }),
    ).rejects.toBe(missing);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("retains the separate explicit legacy replacement transport", async () => {
    await importBuiltinPromptPack("security-red-team-v6");
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/prompt-packs/builtins/security-red-team-v6/import", {
      method: "POST",
    });
  });
});
