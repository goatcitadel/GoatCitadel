import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderSecretField } from "./ProviderSecretField";

const render = (authMode?: string) =>
  renderToStaticMarkup(<ProviderSecretField authMode={authMode} value="" onChange={() => undefined} />);

describe("provider secret field", () => {
  it("names the AWS credentials JSON and its shape for SigV4", () => {
    const markup = render("aws-sigv4");
    expect(markup).toContain(">AWS credentials JSON<");
    expect(markup).toContain(
      "or leave empty to use AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the gateway environment.",
    );
    expect(markup).toContain("&quot;accessKeyId&quot;:&quot;…&quot;");
    expect(markup).not.toContain("Paste a new API key to save");
  });

  it("keeps the API key and service-account wording for other modes", () => {
    expect(render("api-key")).toContain(">Provider secret<");
    expect(render("api-key")).toContain('placeholder="Paste a new API key to save"');
    expect(render("google-service-account")).toContain(">Service-account JSON<");
    expect(render(undefined)).not.toContain("AWS credentials JSON");
  });
});
