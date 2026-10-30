import { expect, it } from "vitest";
import { buildConnectorSetupPage } from "./settings-index";
import { selectedSettingsSection } from "./SettingsSectionTabs";

// Capabilities › Connectors › Advanced setup, where both sign-ins return since Settings › Connections was retired.
const setup = buildConnectorSetupPage();

it("orders Advanced setup MCP servers, Integrations, then Web & Search, opening on MCP servers", () => {
  expect(setup.entries.map((entry) => [entry.section, entry.anchor])).toEqual([
    ["mcp", "mcp-servers"],
    ["integrations", "integration-connections"],
    ["web-search", "web-search"],
  ]);
  expect(selectedSettingsSection(setup, undefined, "")).toBe("mcp");
});

it("opens the MCP section when a provider sign-in lands on Advanced setup, so its return is consumed", () => {
  expect(selectedSettingsSection(setup, undefined, "mcp-oauth-return&state=s-1&code=abc")).toBe("mcp");
  expect(selectedSettingsSection(setup, undefined, "mcp-oauth-return&state=s-1&error=access_denied")).toBe("mcp");
  // After the fragment is consumed it becomes `#mcp-servers`, which still selects MCP.
  expect(selectedSettingsSection(setup, undefined, "mcp-servers")).toBe("mcp");
  // A bare `mcp-oauth-return` is not a return: the page opens on its first section.
  expect(selectedSettingsSection(setup, undefined, "mcp-oauth-return")).toBe("mcp");
  expect(selectedSettingsSection(setup, undefined, "web-search")).toBe("web-search");
});

it("opens Integrations when Google sign-in lands on Advanced setup, even from another saved section", () => {
  expect(selectedSettingsSection(setup, "mcp", "google-oauth-return&state=s-1&code=abc")).toBe("integrations");
  expect(selectedSettingsSection(setup, "mcp", "google-oauth-return&state=s-1&error=access_denied")).toBe(
    "integrations",
  );
  // After the fragment is consumed it becomes `#integration-connections`.
  expect(selectedSettingsSection(setup, undefined, "integration-connections")).toBe("integrations");
});
