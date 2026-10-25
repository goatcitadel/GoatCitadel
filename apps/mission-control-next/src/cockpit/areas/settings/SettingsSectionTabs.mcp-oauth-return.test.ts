import { expect, it } from "vitest";
import { buildSettingsIndex } from "./settings-index";
import { selectedSettingsSection } from "./SettingsSectionTabs";

const connections = buildSettingsIndex().find((page) => page.id === "connections")!;

it("opens the MCP section when a provider sign-in lands on Connections, so its return is consumed", () => {
  expect(selectedSettingsSection(connections, undefined, "mcp-oauth-return&state=s-1&code=abc")).toBe("mcp");
  expect(selectedSettingsSection(connections, undefined, "mcp-oauth-return&state=s-1&error=access_denied")).toBe("mcp");
  // After the fragment is consumed it becomes `#mcp-servers`, which still selects MCP.
  expect(selectedSettingsSection(connections, undefined, "mcp-servers")).toBe("mcp");
  expect(selectedSettingsSection(connections, undefined, "")).toBe("integrations");
  expect(selectedSettingsSection(connections, undefined, "mcp-oauth-return")).toBe("integrations");
});
