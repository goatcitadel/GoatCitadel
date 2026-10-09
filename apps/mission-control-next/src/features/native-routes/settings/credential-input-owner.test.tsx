import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it } from "vitest";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import { hasSessionDraft, useSessionDraft, __resetSessionDraftsForTests } from "../library/session-drafts";
import { useCredentialInput, __resetCredentialInputsForTests } from "./credential-input-owner";
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); __resetSessionDraftsForTests(); __resetCredentialInputsForTests(); setGatewayCallerScope(""); });
it("keeps credential values outside ordinary drafts and preserves caller-bound input", async () => {
  let secret!: ReturnType<typeof useCredentialInput<string>>;
  let publicDraft!: ReturnType<typeof useSessionDraft<string>>;
  function Probe() { secret = useCredentialInput("provider-secret:system:fixture", "", 1, { label: "Credential" }); publicDraft = useSessionDraft("provider-secret:system:fixture", "", 1, { label: "Public draft", active: false }); return null; }
  setGatewayCallerScope("caller-a");
  await act(async () => { view = create(<Probe />); });
  await act(async () => secret.setValue("disposable-input"));
  expect(publicDraft.value).toBe("");
  expect(hasSessionDraft("provider-secret:system:fixture")).toBe(false);
  await act(async () => setGatewayCallerScope("caller-b"));
  expect(secret.value).toBe("");
  await act(async () => setGatewayCallerScope("caller-a"));
  expect(secret.value).toBe("disposable-input");
  await act(async () => { secret.acceptSaved("", 2, "disposable-input"); });
  expect(secret.value).toBe("");
  expect(secret.isDirty).toBe(false);
});
