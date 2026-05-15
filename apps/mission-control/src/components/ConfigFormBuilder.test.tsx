import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { ConfigFormBuilder } from "./ConfigFormBuilder";

function instanceText(node: ReactTestInstance | string | number): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return node.children.map((child) => instanceText(child as ReactTestInstance | string | number)).join(" ");
}

describe("ConfigFormBuilder", () => {
  it("renders grouped field framing and the advanced toggle without changing schema behavior", () => {
    const markup = renderToStaticMarkup(
      <ConfigFormBuilder
        schema={
          {
            title: "Discord connection",
            description: "Connect a delivery channel.",
            fields: [
              {
                key: "token",
                label: "Bot token",
                type: "password",
                required: true,
                secretRef: "DISCORD_TOKEN",
              },
              {
                key: "guildId",
                label: "Guild ID",
                type: "text",
                advanced: true,
              },
            ],
          } as any
        }
        value={{ token: "" }}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("config-form-builder");
    expect(markup).toContain("Bot token");
    expect(markup).toContain("Show Advanced Fields");
    expect(markup).toContain("ENV Ref");
  });

  it("builds field controls that update booleans, selects, numbers, json, and advanced fields", () => {
    const changes: Array<Record<string, unknown>> = [];

    function Harness() {
      const [value, setValue] = React.useState<Record<string, unknown>>({
        enabled: false,
        mode: "auto",
        retries: 3,
        payload: { hello: "world" },
      });

      return (
        <ConfigFormBuilder
          schema={
            {
              title: "Runtime connector",
              fields: [
                { key: "enabled", label: "Enabled", type: "boolean", defaultValue: true },
                {
                  key: "mode",
                  label: "Mode",
                  type: "select",
                  options: [
                    { value: "auto", label: "Auto" },
                    { value: "manual", label: "Manual" },
                  ],
                },
                { key: "retries", label: "Retries", type: "number" },
                { key: "payload", label: "Payload", type: "json" },
                { key: "debug", label: "Debug label", type: "text", advanced: true },
              ],
            } as any
          }
          value={value}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
        />
      );
    }

    const renderer = create(<Harness />);

    expect(renderer.root.findAllByProps({ id: "integration-field-debug" })).toHaveLength(0);

    act(() => {
      renderer.root.findByProps({ id: "integration-field-enabled" }).props.onChange({ target: { checked: true } });
    });
    expect(changes.at(-1)).toMatchObject({ enabled: true });

    const modeSelect = renderer.root.find(
      (node) => node.type === "select" && node.props.id === "integration-field-mode",
    );
    act(() => {
      modeSelect.props.onChange({ target: { value: "manual" } });
    });
    expect(changes.at(-1)).toMatchObject({ mode: "manual" });

    act(() => {
      renderer.root.findByProps({ id: "integration-field-retries" }).props.onChange({ target: { value: "7" } });
    });
    expect(changes.at(-1)).toMatchObject({ retries: 7 });

    act(() => {
      renderer.root.findByProps({ id: "integration-field-payload" }).props.onChange({
        target: { value: '{"ok":true}' },
      });
    });
    expect(changes.at(-1)).toMatchObject({ payload: '{"ok":true}' });

    const advancedButton = renderer.root
      .findAllByType("button")
      .find((button) => instanceText(button).includes("Show Advanced Fields"));
    expect(advancedButton).toBeDefined();

    act(() => {
      advancedButton?.props.onClick();
    });
    act(() => {
      renderer.root.findByProps({ id: "integration-field-debug" }).props.onChange({ target: { value: "verbose" } });
    });

    expect(changes.at(-1)).toMatchObject({ debug: "verbose" });
  });
});
