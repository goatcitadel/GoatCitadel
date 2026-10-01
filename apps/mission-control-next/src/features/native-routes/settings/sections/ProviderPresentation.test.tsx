import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { ProviderProfileFields } from "./ProviderProfileFields";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ProviderAdvicePanel } from "./ProviderAdvicePanel";
import { SettingsActionList, SettingsField, SettingsNotice } from "../SettingsShared";
import { createEmptyProviderEditorDraft } from "../../SettingsNativePage";

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
});
const field = (label: string) => renderer.root.findAllByType(SettingsField).find((item) => item.props.label === label)!;

describe("extracted provider presentation", () => {
  it("changes one controlled public field while preserving the owner draft and transport", () => {
    const draft = { ...createEmptyProviderEditorDraft(), providerId: "local", label: "Local", apiKeyEnv: "LOCAL_KEY" };
    const setProviderDraft = vi.fn();
    const setTransport = vi.fn();
    act(() => {
      renderer = create(
        <ProviderProfileFields
          providerDraft={draft}
          setProviderDraft={setProviderDraft}
          providerTransportDraft={createEmptyLlmTransportDraft()}
          setProviderTransportDraft={setTransport}
          providerRequestValidation={{ error: null }}
        />,
      );
    });
    act(() =>
      field("Base URL")
        .findByType("input")
        .props.onChange({ target: { value: "http://localhost:1234/v1" } }),
    );
    const changed = setProviderDraft.mock.calls[0]![0](draft);
    expect(changed).toEqual({ ...draft, baseUrl: "http://localhost:1234/v1" });
    expect(draft.baseUrl).toBe("");
    expect(setTransport).not.toHaveBeenCalled();
    expect(
      renderer.root.findAllByType("button").some((item) => String(item.props.children).includes("Save provider")),
    ).toBe(false);
  });

  it.each(["google-adc", "codex-oauth"] as const)("preserves %s credential-field restrictions", (authMode) => {
    act(() => {
      renderer = create(
        <ProviderProfileFields
          providerDraft={{ ...createEmptyProviderEditorDraft(), authMode }}
          setProviderDraft={vi.fn()}
          providerTransportDraft={createEmptyLlmTransportDraft()}
          setProviderTransportDraft={vi.fn()}
          providerRequestValidation={{ error: "Invalid transport draft" }}
        />,
      );
    });
    expect(field("API key env")).toBeUndefined();
    if (authMode === "codex-oauth") expect(field("Credential mode").findByType("select").props.disabled).toBe(true);
    else expect(field("Google Cloud project")).toBeDefined();
    expect(
      renderer.root
        .findAllByType(SettingsNotice)
        .some((item) => item.props.notice.message === "Invalid transport draft"),
    ).toBe(true);
  });

  it("keeps blocked models inert and delegates model staging and local endpoint setup", () => {
    const onSelect = vi.fn();
    const onSetup = vi.fn();
    const base = {
      id: "ready",
      providerId: "provider",
      providerLabel: "Provider",
      model: "model",
      label: "Provider/model",
      searchText: "",
      availability: "ready",
      availabilityReason: "Live",
      endpointIdentity: "localhost",
      credentialStatus: "configured",
      probeState: "ready",
    } as const;
    const props: ComponentProps<typeof ProviderModelPicker> = {
      providers: [],
      universalModelOptions: [
        base,
        { ...base, id: "blocked", availability: "blocked" },
        { ...base, id: "local", providerId: "llamacpp" },
      ],
      modelPickerQuery: "",
      setModelPickerQuery: vi.fn(),
      onSetupLlamaCpp: onSetup,
      onSelect,
    };
    act(() => {
      renderer = create(<ProviderModelPicker {...props} />);
    });
    const items = renderer.root.findByType(SettingsActionList).props.items;
    expect(items[1].actionLabel).toBe("Blocked");
    expect(items[1].onClick).toBeUndefined();
    act(() => {
      items[0].onClick();
      items[2].onClick();
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ providerId: "provider", model: "model" });
    expect(onSetup).toHaveBeenCalledOnce();
  });

  it("keeps advice unavailable and loading evidence distinct and delegates only its read callback", () => {
    const onLoad = vi.fn();
    act(() => {
      renderer = create(
        <ProviderAdvicePanel
          providerAdvice={{ loading: false, error: "Owner unavailable", data: null }}
          onLoad={onLoad}
        />,
      );
    });
    expect(
      renderer.root.findAllByType(SettingsNotice).some((item) => item.props.notice.message === "Owner unavailable"),
    ).toBe(true);
    const button = renderer.root.findByType("button");
    act(() => button.props.onClick());
    expect(onLoad).toHaveBeenCalledOnce();
    act(() =>
      renderer.update(
        <ProviderAdvicePanel providerAdvice={{ loading: true, error: null, data: null }} onLoad={onLoad} />,
      ),
    );
    expect(renderer.root.findByType("button").props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Advice has not been loaded.");
  });
});
