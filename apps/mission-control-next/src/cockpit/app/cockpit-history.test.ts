import { describe, expect, it } from "vitest";
import { cockpitHref, retainsSettingsPage } from "./cockpit-history";

describe("native destination ownership", () => {
  it("preserves encoded owner IDs, query scope, and hash while making the shell explicit", () => {
    expect(cockpitHref("/chat?sessionId=one%2Ftwo&workspaceId=scope%3Aa#evidence"))
      .toBe("/chat?sessionId=one%2Ftwo&workspaceId=scope%3Aa&shell=cockpit#evidence");
    for (const href of ["https://foreign.invalid/chat", "//foreign.invalid/chat", "/\\foreign.invalid/chat",
      "/chat?shell=classic", "/chat?shell=cockpit&shell=classic"]) expect(cockpitHref(href)).toBeNull();
  });

  it("retains only known tabs of the same mounted Settings page and unchanged query scope", () => {
    expect(retainsSettingsPage("/settings/general#appearance", "/settings/general?shell=cockpit#work-personality")).toBe(true);
    expect(retainsSettingsPage("/settings/safety?shell=cockpit#approval-mode", "/settings/safety?shell=cockpit#hooks")).toBe(true);
    for (const href of ["/settings/connections#channels", "/settings/first-run", "/settings/general#unknown",
      "/settings/general?workspaceId=other#work-personality", "/settings/general?shell=classic#work-personality"]) {
      expect(retainsSettingsPage("/settings/general#appearance", href)).toBe(false);
    }
    expect(retainsSettingsPage("/chat?sessionId=a", "/chat?sessionId=b#evidence")).toBe(false);
    expect(retainsSettingsPage("/settings/first-run", "/settings/first-run#appearance")).toBe(false);
  });
});
