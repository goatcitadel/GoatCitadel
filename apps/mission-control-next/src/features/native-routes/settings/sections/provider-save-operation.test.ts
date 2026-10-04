import { describe, expect, it } from "vitest";
import {
  createEmptyLlmTransportDraft,
  draftFromRequestConfig,
} from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { buildProviderEditorDraft } from "../helpers/provider-drafts";
import { prepareProviderSave, sendsProviderChanges } from "./provider-save-operation";

const baseline = {
  provider: buildProviderEditorDraft({
    providerId: "fixture",
    label: "Fixture",
    baseUrl: "https://fixture.example/v1",
    defaultModel: "fixture-model",
  }),
  transport: draftFromRequestConfig({ headers: { "X-Existing": "keep" } }),
};
describe("provider operation selection", () => {
  it("omits unchanged transport from a governed public-profile save", () => {
    const result = prepareProviderSave(
      { ...baseline, provider: { ...baseline.provider, label: "Renamed" } },
      baseline,
      true,
    );
    expect(result.kind).toBe("profile");
    expect(result).not.toHaveProperty("profile.request");
  });
  it("permits a separate transport edit without public fields in its operation", () => {
    const draft = { ...baseline, transport: draftFromRequestConfig({ headers: { "X-Existing": "changed" } }) };
    expect(prepareProviderSave(draft, baseline, true)).toEqual({
      kind: "transport",
      providerId: "fixture",
      request: { headers: { "X-Existing": "changed" }, auth: undefined, proxy: undefined, tls: undefined },
    });
    expect(() =>
      prepareProviderSave({ ...draft, provider: { ...draft.provider, label: "Changed" } }, baseline, true),
    ).toThrow("separate change");
    expect(() => prepareProviderSave(draft, baseline, false)).toThrow("separate change");
  });
  it("withholds unsupported deletion and inline auth before dispatch", () => {
    expect(() =>
      prepareProviderSave({ ...baseline, transport: createEmptyLlmTransportDraft() }, baseline, true),
    ).toThrow("preserves omitted fields");
    const transport = draftFromRequestConfig({
      headers: { "X-Existing": "keep" },
      auth: { type: "bearer", token: "synthetic-only" },
    });
    expect(() => prepareProviderSave({ ...baseline, transport }, baseline, true)).toThrow(
      "Inline transport credentials",
    );
  });
});
describe("provider save changes", () => {
  it("ignores draft edits that the save normalizes away", () => {
    expect(sendsProviderChanges(baseline, baseline)).toBe(false);
    const padded = { ...baseline.provider, label: " Fixture ", baseUrl: "https://fixture.example/v1 " };
    expect(sendsProviderChanges({ ...baseline, provider: padded }, baseline)).toBe(false);
    const reformatted = { ...baseline.transport, headersJson: '{"X-Existing":"keep"}' };
    expect(reformatted.headersJson).not.toBe(baseline.transport.headersJson);
    expect(sendsProviderChanges({ ...baseline, transport: reformatted }, baseline)).toBe(false);
  });
  it("counts every field a save would send differently", () => {
    expect(sendsProviderChanges({ ...baseline, provider: { ...baseline.provider, label: "Renamed" } }, baseline)).toBe(
      true,
    );
    const transport = draftFromRequestConfig({ headers: { "X-Existing": "changed" } });
    expect(sendsProviderChanges({ ...baseline, transport }, baseline)).toBe(true);
  });
  it("counts credential custody only where the save sends it", () => {
    const provider = { ...baseline.provider, apiKeyEnv: "FIXTURE_KEY" };
    const created = { ...baseline, provider, governedCreation: true, credentialStorage: "keychain" as const };
    expect(sendsProviderChanges({ ...created, credentialStorage: "env" }, created)).toBe(true);
    // An existing profile's save never carries custody.
    expect(sendsProviderChanges({ ...baseline, provider, credentialStorage: "env" }, { ...baseline, provider })).toBe(
      false,
    );
    // Plaintext custody without a valid variable is refused, as the save refuses it.
    const unnamed = { ...created, provider: baseline.provider, credentialStorage: "env" as const };
    expect(() => sendsProviderChanges(unnamed, created)).toThrow("valid API key environment variable");
  });
});
