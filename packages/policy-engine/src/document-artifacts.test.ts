import { describe, expect, it } from "vitest";
import { createArtifactDesignPlan } from "./artifact-design.js";
import { createDocumentArtifact, MODEL_AUTHORED_HTML_MAX_BYTES } from "./document-artifacts.js";

const MODEL_HTML = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Launch</title>',
  "<style>body{font-family:Inter,sans-serif}</style></head>",
  "<body><main><h1>Launch <em>plan</em></h1><p>Ship on Friday &amp; celebrate.</p></main></body></html>",
].join("\n");

function input(overrides: Record<string, unknown> = {}) {
  const title = "Launch plan";
  return {
    title,
    body: "Ship on Friday <b>& celebrate</b>.",
    sections: [{ heading: "Timeline", body: "Three days.", bullets: ["Build", "Test"] }],
    design: createArtifactDesignPlan({ kind: "document", title, format: "html" }),
    ...overrides,
  };
}

describe("createDocumentArtifact html markup", () => {
  it("writes model-authored html verbatim and reports the markup source", async () => {
    const artifact = await createDocumentArtifact("html", input({ html: MODEL_HTML }));

    expect(artifact.data).toBe(MODEL_HTML);
    expect(artifact.markup).toBe("model-authored");
    expect(artifact.mimeType).toBe("text/html");
  });

  it("renders the template when no html is supplied and escapes the content", async () => {
    const artifact = await createDocumentArtifact("html", input());

    expect(artifact.markup).toBe("template");
    expect(artifact.data).toContain("Ship on Friday &lt;b&gt;&amp; celebrate&lt;/b&gt;.");
    expect(artifact.data).toContain("<h2>Timeline</h2>");
  });

  it("falls back to the template for html that is not a document and for other formats", async () => {
    const fragment = await createDocumentArtifact("html", input({ html: "<h1>Just a fragment</h1>" }));
    expect(fragment.markup).toBe("template");
    expect(fragment.data).not.toContain("Just a fragment");

    const markdown = await createDocumentArtifact("markdown", input({ html: MODEL_HTML }));
    expect(markdown.markup).toBe("template");
    expect(markdown.data).toContain("# Launch plan");
  });

  it("refuses model-authored html above the size cap", async () => {
    const oversized = `<!doctype html><html><body>${"x".repeat(MODEL_AUTHORED_HTML_MAX_BYTES)}</body></html>`;

    await expect(createDocumentArtifact("html", input({ html: oversized }))).rejects.toThrow(
      /model_authored_html_too_large/u,
    );
  });
});
