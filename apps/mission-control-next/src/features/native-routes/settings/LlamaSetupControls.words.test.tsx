// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlamaSetupControls } from "./LlamaSetupControls";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetLlamaSetupForTests } from "./llama-setup-state";
import { llamaProjectionFixture } from "./llama-setup.test-support";
import { prepareReadyDialogFixture } from "../../../test/ready-dialog-fixture";

prepareReadyDialogFixture("shared");
const api = vi.hoisted(() => ({
  fetchLlamaCppSetup: vi.fn(),
  previewLlmModels: vi.fn(),
  stageLlamaCppManagedSelection: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  testLlamaCppChat: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  respondToChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const WORKSPACE = "ws_8f3a91c2";
const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  __resetLlamaSetupForTests();
  __resetSessionDraftsForTests();
  api.fetchLlamaCppSetup.mockResolvedValue(llamaProjectionFixture());
  api.previewLlmModels.mockResolvedValue({ source: "live", items: [{ id: "served-model" }] });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  __resetSessionDraftsForTests();
  __resetLlamaSetupForTests();
});
async function mount(cockpit: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<LlamaSetupControls workspaceId={WORKSPACE} cockpit={cockpit} />));
  await vi.waitFor(() => expect(host.textContent).toContain("Chat uses"));
  return host;
}

describe("local AI setup words (U-ST-012)", () => {
  it.each([false, true])("names the process and route without ids (cockpit=%s)", async (cockpit) => {
    const host = await mount(cockpit);
    const section = host.querySelector('section[aria-label="Validated llama.cpp setup"]')!;
    const details = [...section.querySelectorAll("details")].filter((item) =>
      item.querySelector("summary")?.textContent?.includes("Technical details"),
    );
    const visible = [...section.querySelectorAll("p")]
      .filter((item) => !item.closest("details"))
      .map((item) => item.textContent)
      .join("\n");
    expect(visible).toContain(
      "Choose a runtime and model for this GoatCitadel installation. Setup plans and the diagnostic Chat are saved in this workspace.",
    );
    expect(visible).toContain(
      "Started outside GoatCitadel; GoatCitadel only watches it. Chat uses old-model from the model setup in Settings › Models.",
    );
    expect(visible).not.toContain("ws_");
    expect(visible).not.toContain("openai");
    expect(visible).not.toContain("Ownership");
    expect(visible).not.toContain("Gateway installation");
    expect(details[0]?.textContent).toContain(WORKSPACE);
  });
});
