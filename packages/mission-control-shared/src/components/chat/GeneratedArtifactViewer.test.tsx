// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { GeneratedArtifactViewer, hardenMermaidSvg, isSafeSvgLinkTarget } from "./GeneratedArtifactViewer";

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
  it("preserves SVG node and edge labels while removing embedded HTML", () => {
    const hardened = hardenMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><text><tspan>Recorded input</tspan></text></g><text>Visible output</text><foreignObject><p>HTML label</p></foreignObject></svg>');
    expect(hardened).toContain("Recorded input");
    expect(hardened).toContain("Visible output");
    expect(hardened).not.toContain("HTML label");
    expect(hardened).not.toContain("foreignObject");
  });
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

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => { throw new Error("Owned parse failure"); }) } }));
it.each(["text", "code", "mermaid", "html"] as const)("preserves exact %s bytes in accessible source or sandboxed preview", async kind => {
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const content=kind==='mermaid'?'invalid diagram\n  exact source':kind==='html'?'<script>untrusted()</script>':'long '+ 'x'.repeat(500)+'\n  exact indentation';
  const artifact={artifactId:'owned',title:'Generated note',kind,content,version:1,sourceSurface:'chat',createdAt:'2026-10-06T00:00:00Z'} as ChatGeneratedArtifactRecord;
  try {
    await act(async()=>root.render(<GeneratedArtifactViewer artifact={artifact} compact/>));
    if(kind==='html') {expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('');expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toBe(content);}
    else { const region=host.querySelector<HTMLElement>('[role="region"]')!;expect(region.textContent).toBe(content);expect(region.getAttribute('aria-label')).toBe(kind==='mermaid'?'Diagram source':'Artifact source: Generated note');region.focus();expect(document.activeElement).toBe(region); }
  } finally {await act(async()=>root.unmount());host.remove();}
});
