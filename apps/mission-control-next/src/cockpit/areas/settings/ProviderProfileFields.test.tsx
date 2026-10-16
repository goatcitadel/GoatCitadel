import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProviderEditorDraft } from "../../../features/native-routes/settings/helpers/provider-drafts";
import { ProviderProfileFields } from "./ProviderProfileFields";

vi.mock("./ProviderTransportFields", () => ({ ProviderTransportFields: () => null }));

describe("provider profile fields", () => {
  it("labels API styles in plain words and keeps wire values only in option values", () => {
    const markup = renderToStaticMarkup(
      <ProviderProfileFields
        providerDraft={{ ...createEmptyProviderEditorDraft(), apiStyle: "anthropic-messages" }}
        setProviderDraft={() => undefined}
        providerTransportDraft={{} as never}
        setProviderTransportDraft={() => undefined}
        providerRequestValidation={{ error: null }}
        disabled={false}
        existing={false}
      />,
    );
    expect(markup).toContain('<option value="anthropic-messages" selected="">Anthropic Messages</option>');
    expect(markup).toContain('<option value="openai-responses">OpenAI Responses</option>');
    expect(markup).not.toContain(">openai-responses<");
    expect(markup).not.toContain(">bedrock-messages<");
  });

  const renderBedrock = (authMode: "" | "aws-sigv4" | "aws-bedrock-api-key") =>
    renderToStaticMarkup(
      <ProviderProfileFields
        providerDraft={{ ...createEmptyProviderEditorDraft(), apiStyle: "bedrock-messages", authMode }}
        setProviderDraft={() => undefined}
        providerTransportDraft={{} as never}
        setProviderTransportDraft={() => undefined}
        providerRequestValidation={{ error: null }}
        disabled={false}
        existing={false}
      />,
    );

  it("offers Bedrock credential modes in plain words only for the Bedrock API style", () => {
    const markup = renderBedrock("");
    expect(markup).toContain('<option value="aws-bedrock-api-key">Bedrock API key</option>');
    expect(markup).toContain('<option value="aws-sigv4">AWS access key (SigV4)</option>');
    expect(markup).toContain(">Amazon Bedrock messages<");
    expect(markup).not.toContain(">aws-sigv4<");
    expect(markup).not.toContain(">bedrock-messages<");
    const anthropic = renderToStaticMarkup(
      <ProviderProfileFields
        providerDraft={{ ...createEmptyProviderEditorDraft(), apiStyle: "anthropic-messages" }}
        setProviderDraft={() => undefined}
        providerTransportDraft={{} as never}
        setProviderTransportDraft={() => undefined}
        providerRequestValidation={{ error: null }}
        disabled={false}
        existing={false}
      />,
    );
    expect(anthropic).not.toContain('value="aws-sigv4"');
    expect(anthropic).not.toContain('value="aws-bedrock-api-key"');
  });

  it("explains the SigV4 credential JSON and the AWS environment fallback", () => {
    const markup = renderBedrock("aws-sigv4");
    expect(markup).toContain("AWS credentials JSON environment variable");
    expect(markup).toContain("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the gateway environment.");
    expect(renderBedrock("aws-bedrock-api-key")).not.toContain("AWS credentials JSON");
  });
});
