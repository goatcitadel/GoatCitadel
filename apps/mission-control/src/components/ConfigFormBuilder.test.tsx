import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigFormBuilder } from "./ConfigFormBuilder";

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
});
