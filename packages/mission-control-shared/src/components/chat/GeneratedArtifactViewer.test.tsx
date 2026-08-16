// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { hardenMermaidSvg, isSafeSvgLinkTarget } from "./GeneratedArtifactViewer";

describe("isSafeSvgLinkTarget", () => {
  it("allows fragment, http(s), mailto, and relative targets", () => {
    expect(isSafeSvgLinkTarget("#node-1")).toBe(true);
    expect(isSafeSvgLinkTarget("https://example.com/docs")).toBe(true);
    expect(isSafeSvgLinkTarget("http://example.com")).toBe(true);
    expect(isSafeSvgLinkTarget("mailto:ops@example.com")).toBe(true);
    expect(isSafeSvgLinkTarget("diagram-notes.svg")).toBe(true);
    expect(isSafeSvgLinkTarget("")).toBe(true);
  });

  it("rejects script-capable and unknown schemes", () => {
    expect(isSafeSvgLinkTarget("javascript:alert(1)")).toBe(false);
    expect(isSafeSvgLinkTarget(" jAvAsCrIpT:alert(1)")).toBe(false);
    expect(isSafeSvgLinkTarget("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeSvgLinkTarget("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeSvgLinkTarget("file:///etc/passwd")).toBe(false);
  });
});

describe("hardenMermaidSvg", () => {
  it("strips script elements, foreignObject, and inline event handlers", () => {
    const hardened = hardenMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        "<script>alert(1)</script>" +
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>' +
        '<rect onclick="alert(2)" width="10" height="10"/>' +
        "</svg>",
    );
    expect(hardened).not.toContain("<script");
    expect(hardened).not.toContain("foreignObject");
    expect(hardened).not.toContain("onclick");
    expect(hardened).toContain("<rect");
  });

  it("removes javascript: hrefs while keeping safe link targets", () => {
    const hardened = hardenMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a href="javascript:alert(1)"><text>bad</text></a>' +
        '<a xlink:href="javascript:alert(2)"><text>bad legacy</text></a>' +
        '<a href="https://example.com/docs"><text>good</text></a>' +
        '<use href="#shape"/>' +
        "</svg>",
    );
    expect(hardened).not.toContain("javascript:");
    expect(hardened).toContain('href="https://example.com/docs"');
    expect(hardened).toContain('href="#shape"');
  });
});
