import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchPathSuggestions: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchPathSuggestions: apiMocks.fetchPathSuggestions,
}));

vi.mock("./SelectOrCustom", () => ({
  SelectOrCustom: (props: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    customPlaceholder?: string;
  }) => (
    <div data-testid="select-or-custom" data-value={props.value} data-options={props.options}>
      <input
        aria-label="custom path"
        placeholder={props.customPlaceholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  ),
}));

import { SmartPathInput } from "./SmartPathInput";

function SmartPathHarness(props: { initialValue?: string; root?: string; limit?: number }) {
  const [value, setValue] = useState(props.initialValue ?? "");
  return (
    <SmartPathInput
      label="Workspace path"
      value={value}
      onChange={setValue}
      root={props.root}
      limit={props.limit}
      riskLevel="warning"
      helpText="Choose a workspace-local path."
    />
  );
}

function rendererText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => Array.isArray(node.children))
    .map((node) => node.children.join(""))
    .join(" ");
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SmartPathInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads suggestions, autofills the first path, and warns when the operator edits after autofill", async () => {
    apiMocks.fetchPathSuggestions.mockResolvedValueOnce({
      items: ["apps/mission-control/src/App.tsx", "apps/gateway/src/index.ts"],
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<SmartPathHarness root="apps" limit={2} />);
    });
    await flush();

    const picker = renderer.root.findByProps({ "data-testid": "select-or-custom" });
    expect(picker.props["data-options"]).toEqual([
      {
        value: "apps/mission-control/src/App.tsx",
        label: "apps/mission-control/src/App.tsx",
      },
      {
        value: "apps/gateway/src/index.ts",
        label: "apps/gateway/src/index.ts",
      },
    ]);

    const browse = renderer.root.findByType("button");
    await act(async () => {
      browse.props.onClick();
    });
    expect(renderer.root.findByProps({ "data-testid": "select-or-custom" }).props["data-value"]).toBe(
      "apps/mission-control/src/App.tsx",
    );

    const input = renderer.root.findByProps({ "aria-label": "custom path" });
    await act(async () => {
      input.props.onChange({ target: { value: "apps/mission-control/src/pages/ChatPage.tsx" } });
    });

    expect(rendererText(renderer)).toContain("Path edited after auto-fill.");
    expect(rendererText(renderer)).toContain("Choose a workspace-local path.");
    expect(apiMocks.fetchPathSuggestions).toHaveBeenCalledWith("apps", 2);
  });

  it("disables browse and clears suggestions when the path suggestion lookup fails", async () => {
    apiMocks.fetchPathSuggestions.mockRejectedValueOnce(new Error("lookup failed"));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<SmartPathHarness />);
    });
    await flush();

    expect(renderer.root.findByType("button").props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "data-testid": "select-or-custom" }).props["data-options"]).toEqual([]);
  });
});
