import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { promptPackChangeError } from "./PromptPacksWorkbenchPage.helpers";

const refused = (status: number, body: Record<string, unknown>) =>
  new ApiRequestError("refused", { kind: "http", method: "POST", path: "/api/v1/prompt-packs/x/reset", status, body });

describe("a change to a plugin's prompt pack", () => {
  // Packs carry no plugin mark yet, so Reset stays on a plugin's pack; GoatCitadel refuses it in its own words (D10).
  it("answers Reset on a plugin's prompt pack with the plugin's own sentence", () => {
    const error = refused(409, {
      error: "From Meeting tools. Uninstall it to remove this.",
      code: "PLUGIN_OWNED",
      details: { pluginId: "meeting-tools" },
    });

    expect(promptPackChangeError(error)).toBe("From Meeting tools. Uninstall it to remove this.");
  });

  it("keeps the plain wording for any other conflict", () => {
    expect(promptPackChangeError(refused(409, { error: "Changed.", code: "WRITE_CONFLICT" }))).toBe(
      "This changed somewhere else. Refresh and try again.",
    );
  });
});
