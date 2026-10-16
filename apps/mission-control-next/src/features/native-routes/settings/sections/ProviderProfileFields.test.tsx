import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProviderEditorDraft, type ProviderEditorDraft } from "../helpers/provider-drafts";
import { ProviderProfileFields } from "./ProviderProfileFields";

vi.mock("@goatcitadel/mission-control-shared/components/LlmTransportFields", () => ({
  LlmTransportFields: () => null,
}));

function render(draft: Partial<ProviderEditorDraft>): string {
  return renderToStaticMarkup(
    <ProviderProfileFields
      providerDraft={{ ...createEmptyProviderEditorDraft(), ...draft }}
      setProviderDraft={() => undefined}
      providerTransportDraft={{} as never}
      setProviderTransportDraft={() => undefined}
      providerRequestValidation={{ error: null }}
    />,
  );
}

describe("native provider profile fields", () => {
  it("labels the Bedrock API style and offers Bedrock credential modes in plain words", () => {
    const markup = render({ apiStyle: "bedrock-messages" });
    expect(markup).toContain('<option value="bedrock-messages" selected="">Amazon Bedrock messages</option>');
    expect(markup).toContain('<option value="aws-bedrock-api-key">Bedrock API key</option>');
    expect(markup).toContain('<option value="aws-sigv4">AWS access key (SigV4)</option>');
    expect(markup).not.toContain(">bedrock-messages<");
    expect(markup).not.toContain(">aws-sigv4<");
  });

  it("hides Bedrock credential modes for other API styles", () => {
    const markup = render({ apiStyle: "anthropic-messages" });
    expect(markup).not.toContain('value="aws-sigv4"');
    expect(markup).not.toContain('value="aws-bedrock-api-key"');
  });

  it("explains the SigV4 credential JSON and the AWS environment fallback", () => {
    const markup = render({ apiStyle: "bedrock-messages", authMode: "aws-sigv4" });
    expect(markup).toContain("AWS credentials JSON env");
    expect(markup).toContain("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the gateway environment.");
  });
});
