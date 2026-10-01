// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetVoiceAttemptsForTests } from "../../../features/native-routes/settings/voice-runtime-state";
import {
  selectedVoiceRuntime,
  voiceRuntimeFixture,
} from "../../../features/native-routes/settings/voice-runtime.test-support";
import { VoiceRuntimeSettings } from "./VoiceRuntimeSettings";
const api = vi.hoisted(() => ({
  fetchVoiceRuntimeStatus: vi.fn(),
  installVoiceRuntime: vi.fn(),
  selectVoiceRuntimeModel: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let modal: ComponentProps<typeof ConfirmModal>;
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    modal = props;
    return null;
  },
}));
let renderer: ReactTestRenderer,
  client: QueryClient,
  owner = voiceRuntimeFixture();
const button = (label: string) =>
  renderer.root.findAllByType("button").find((item) => item.children.join("") === label)!;
async function mount(show = true) {
  await act(async () => {
    const tree = <QueryClientProvider client={client}>{show ? <VoiceRuntimeSettings /> : null}</QueryClientProvider>;
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  owner = voiceRuntimeFixture();
  api.fetchVoiceRuntimeStatus.mockImplementation(async () => owner);
  api.installVoiceRuntime.mockImplementation(async () => {
    owner = selectedVoiceRuntime(owner, "base");
    return owner;
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await mount();
  await vi.waitFor(() => expect(button("Install starter model").props.disabled).toBe(false));
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  renderer = undefined as unknown as ReactTestRenderer;
  client.clear();
  __resetVoiceAttemptsForTests();
});
describe("native local voice settings", () => {
  it("shows exact consequences and requires review before installation", async () => {
    await act(async () => button("Install starter model").props.onClick());
    expect(modal.open).toBe(true);
    expect(modal.message).toContain("Base English");
    expect(modal.message).toContain("100 MB");
    expect(modal.message).toContain("no atomic revision guard");
    expect(api.installVoiceRuntime).not.toHaveBeenCalled();
    await act(async () => modal.onCancel());
    expect(api.installVoiceRuntime).not.toHaveBeenCalled();
    await act(async () => button("Install starter model").props.onClick());
    await act(async () => modal.onConfirm());
    expect(api.installVoiceRuntime).toHaveBeenCalledExactlyOnceWith({ modelId: "base", activate: true });
    expect(
      renderer.root.findAllByType("button").some((item) => String(item.props.className).includes("mc-next-button")),
    ).toBe(false);
  });
  it("preserves the uncertain installation lock after remount", async () => {
    api.installVoiceRuntime.mockRejectedValue(Error("lost response"));
    await act(async () => button("Install starter model").props.onClick());
    await act(async () => modal.onConfirm());
    await mount(false);
    await mount();
    expect(button("Install starter model").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("outcome is uncertain");
    expect(api.installVoiceRuntime).toHaveBeenCalledOnce();
  });
  it("withholds unsafe actions for a partial successful owner response", async () => {
    api.fetchVoiceRuntimeStatus.mockResolvedValue({ provider: "whisper.cpp" });
    await act(async () => button("Refresh voice runtime").props.onClick());
    await vi.waitFor(() => expect(button("Install starter model").props.disabled).toBe(true));
    expect(JSON.stringify(renderer.toJSON())).toContain("No voice models were reported");
    expect(api.installVoiceRuntime).not.toHaveBeenCalled();
  });
});
