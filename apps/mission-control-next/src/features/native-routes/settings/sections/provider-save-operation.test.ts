import { describe, expect, it } from "vitest";
import { createEmptyLlmTransportDraft, draftFromRequestConfig } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { buildProviderEditorDraft } from "../helpers/provider-drafts";
import { prepareProviderSave } from "./provider-save-operation";

const baseline = {
  provider: buildProviderEditorDraft({ providerId: "fixture", label: "Fixture", baseUrl: "https://fixture.example/v1", defaultModel: "fixture-model" }),
  transport: draftFromRequestConfig({ headers: { "X-Existing": "keep" } }),
};
describe("provider operation selection", () => {
  it("omits unchanged transport from a governed public-profile save", () => {
    const result = prepareProviderSave({ ...baseline, provider: { ...baseline.provider, label: "Renamed" } }, baseline, true);
    expect(result.kind).toBe("profile");
    expect(result).not.toHaveProperty("profile.request");
  });
  it("permits a separate transport edit without public fields in its operation", () => {
    const draft = { ...baseline, transport: draftFromRequestConfig({ headers: { "X-Existing": "changed" } }) };
    expect(prepareProviderSave(draft, baseline, true)).toEqual({ kind: "transport", providerId: "fixture", request: { headers: { "X-Existing": "changed" }, auth: undefined, proxy: undefined, tls: undefined } });
    expect(() => prepareProviderSave({ ...draft, provider: { ...draft.provider, label: "Changed" } }, baseline, true)).toThrow("separate change");
    expect(() => prepareProviderSave(draft, baseline, false)).toThrow("separate change");
  });
  it("withholds unsupported deletion and inline auth before dispatch", () => {
    expect(() => prepareProviderSave({ ...baseline, transport: createEmptyLlmTransportDraft() }, baseline, true)).toThrow("preserves omitted fields");
    const transport = draftFromRequestConfig({ headers: { "X-Existing": "keep" }, auth: { type: "bearer", token: "synthetic-only" } });
    expect(() => prepareProviderSave({ ...baseline, transport }, baseline, true)).toThrow("Inline transport credentials");
  });
});
