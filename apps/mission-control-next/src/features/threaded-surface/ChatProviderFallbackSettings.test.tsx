// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatProviderFallbackSettings } from "./ChatProviderFallbackSettings";

const link = <a href="/settings/advanced#feature-switch-provider-fallback">Turn it on in Settings › Advanced</a>;
function fixture() {
  return {
    prefs: null,
    selectedProviderId: "local",
    providerOptions: [
      { providerId: "local", label: "Local", models: ["local-model"], isLocalRuntime: true },
      { providerId: "hosted", label: "Hosted", models: ["hosted-model"], defaultModel: "hosted-model" },
    ],
    providerFallbackAvailable: true,
    sending: false,
    selectedTurn: null,
    routePreflight: null,
    onPrefPatch: vi.fn(async () => {}),
    loadModelsForProvider: vi.fn(async () => ["hosted-model"]),
  };
}

async function render(props: ReturnType<typeof fixture>) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<ChatProviderFallbackSettings {...props} />);
  });
  return tree;
}

describe("Chat fallback preference", () => {
  it("renders with no query client, with the old wording and no link, as Classic does", async () => {
    // No QueryClientProvider here: Classic has none, and this must not throw.
    const tree = await render({ ...fixture(), providerFallbackAvailable: false });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Provider fallback is not enabled for this runtime.");
    expect(json).not.toContain("Turn it on in Settings");
    await act(async () => tree.unmount());
  });

  it("names resumable runs, with no link, when the switch is on but fallback is still unavailable", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ChatProviderFallbackSettings
          {...fixture()}
          providerFallbackAvailable={false}
          switchOn
          featureOffLink={link}
        />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("needs resumable runs, which are turned off on this installation");
    expect(json).not.toContain("Turn it on in Settings");
    await act(async () => tree.unmount());
  });

  it("does not claim fallback is turned off while its switch has not been read", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ChatProviderFallbackSettings {...fixture()} providerFallbackAvailable={false} featureOffLink={link} />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain("Provider fallback is not enabled for this runtime.");
    expect(json).not.toContain("turned off");
    expect(json).not.toContain("Turn it on in Settings");
    await act(async () => tree.unmount());
  });

  it("starts off, never defaults to hosted consent, and saves one exact target", async () => {
    const props = fixture();
    const tree = await render(props);
    expect(tree.root.findByProps({ "aria-label": "Fallback provider" }).props.value).toBe("");
    expect(tree.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
    expect(props.onPrefPatch).not.toHaveBeenCalled();
    await act(async () => {
      tree.root.findByProps({ "aria-label": "Fallback provider" }).props.onChange({ target: { value: "hosted" } });
    });
    expect(tree.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);
    await act(async () => {
      tree.root.findByType("button").props.onClick();
    });
    expect(props.onPrefPatch).toHaveBeenCalledWith({
      providerFallback: {
        providerId: "hosted",
        model: "hosted-model",
        allowLocalToCloud: false,
      },
    });
    await act(async () => tree.unmount());
  });

  it("saves explicit boundary consent and disabling as an atomic null preference", async () => {
    const props = fixture();
    const tree = await render(props);
    await act(async () => {
      tree.root.findByProps({ "aria-label": "Fallback provider" }).props.onChange({ target: { value: "hosted" } });
    });
    await act(async () => {
      tree.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      tree.root.findByType("button").props.onClick();
    });
    expect(props.onPrefPatch).toHaveBeenLastCalledWith({
      providerFallback: {
        providerId: "hosted",
        model: "hosted-model",
        allowLocalToCloud: true,
      },
    });
    await act(async () => {
      tree.update(
        <ChatProviderFallbackSettings
          {...props}
          prefs={
            {
              providerFallback: { providerId: "hosted", model: "hosted-model", allowLocalToCloud: true },
            } as never
          }
        />,
      );
    });
    await act(async () => {
      tree.root.findByProps({ "aria-label": "Fallback provider" }).props.onChange({ target: { value: "" } });
    });
    await act(async () => {
      tree.root.findByType("button").props.onClick();
    });
    expect(props.onPrefPatch).toHaveBeenLastCalledWith({ providerFallback: null });
    await act(async () => tree.unmount());
  });

  it("shows Gateway readiness and the selected turn's actual switch separately", async () => {
    const props = fixture();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <ChatProviderFallbackSettings
          {...props}
          routePreflight={
            {
              fallbackPolicy: "armed",
              providerFallback: { providerId: "hosted", model: "hosted-model", allowLocalToCloud: true },
            } as never
          }
          selectedTurn={
            {
              trace: {
                routing: {
                  fallbackUsed: true,
                  primaryProviderId: "local",
                  primaryModel: "local-model",
                  effectiveProviderId: "hosted",
                  effectiveModel: "hosted-model",
                },
              },
            } as never
          }
        />,
      );
    });
    const statusText = tree.root
      .findAllByProps({ role: "status" })
      .map((p) => p.children.join(""))
      .join(" ");
    expect(statusText).toContain("Available fallback: hosted / hosted-model");
    expect(statusText).toContain("Selected turn switched from local / local-model to hosted / hosted-model");
    await act(async () => tree.unmount());
  });

  it("keeps unknown targets inactive and blocks saving an empty model", async () => {
    const props = fixture();
    const tree = await render(props);
    await act(async () => {
      tree.root.findByProps({ "aria-label": "Fallback provider" }).props.onChange({ target: { value: "hosted" } });
    });
    await act(async () => {
      tree.root.findByProps({ "aria-label": "Fallback model" }).props.onChange({ target: { value: "  " } });
    });
    expect(tree.root.findByType("button").props.disabled).toBe(true);
    await act(async () => {
      tree.update(
        <ChatProviderFallbackSettings
          {...props}
          prefs={{ providerFallback: { providerId: "missing", model: "m", allowLocalToCloud: false } } as never}
        />,
      );
    });
    expect(tree.root.findByProps({ role: "status" }).children.join("")).toContain("Saved fallback is inactive");
    expect(tree.root.findByType("button").props.disabled).toBe(true);
    await act(async () => tree.unmount());
  });

  it.each([false, undefined])(
    "does not present stale armed preflight as available when rollout availability is %s",
    async (availability) => {
      const props = fixture();
      let tree!: ReactTestRenderer;
      await act(async () => {
        tree = create(
          <ChatProviderFallbackSettings
            {...props}
            providerFallbackAvailable={availability}
            switchOn={false}
            featureOffLink={link}
            routePreflight={
              {
                fallbackPolicy: "armed",
                providerFallback: { providerId: "hosted", model: "hosted-model", allowLocalToCloud: true },
              } as never
            }
          />,
        );
      });
      expect(JSON.stringify(tree.toJSON())).toContain("Provider fallback is turned off on this installation.");
      expect(JSON.stringify(tree.toJSON())).toContain("feature-switch-provider-fallback");
      expect(JSON.stringify(tree.toJSON())).not.toContain("not enabled for this runtime");
      await act(async () => tree.unmount());
    },
  );
});
