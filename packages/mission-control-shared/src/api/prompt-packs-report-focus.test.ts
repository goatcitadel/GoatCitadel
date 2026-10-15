import { beforeEach, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./client-core.js", () => ({ request }));
import { fetchPromptPackReport } from "./prompt-packs.js";
beforeEach(() => request.mockReset());
it("preserves the exact default report request", async () => {
  const response = {};
  request.mockResolvedValueOnce(response);
  expect(await fetchPromptPackReport("pack/one")).toBe(response);
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/prompt-packs/pack%2Fone/report");
});
it("carries exact run/session focus through the existing GET owner", async () => {
  await fetchPromptPackReport("pack/one", { runId: "run/two", sessionId: "session:three" });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "/api/v1/prompt-packs/pack%2Fone/report?runId=run%2Ftwo&sessionId=session%3Athree",
  );
});
it("preserves canonical run/session ID bytes without trimming", async () => {
  await fetchPromptPackReport("pack", { runId: " run/one ", sessionId: " session:one " });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "/api/v1/prompt-packs/pack/report?runId=+run%2Fone+&sessionId=+session%3Aone+",
  );
});
it("does not broaden a failed focused read to the default report", async () => {
  const denied = Object.assign(new Error("Unavailable"), { status: 404 });
  request.mockRejectedValueOnce(denied);
  await expect(fetchPromptPackReport("pack", { runId: "missing" })).rejects.toBe(denied);
  expect(request).toHaveBeenCalledTimes(1);
});
