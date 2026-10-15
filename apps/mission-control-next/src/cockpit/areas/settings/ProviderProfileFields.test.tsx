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
});
