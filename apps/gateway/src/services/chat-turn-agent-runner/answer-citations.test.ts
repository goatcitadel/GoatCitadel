import { describe, expect, it } from "vitest";
import type { ChatCitationRecord, ChatToolRunRecord } from "@goatcitadel/contracts";
import { selectAnswerCitations } from "./answer-citations.js";

function webCitation(id: string, url: string): ChatCitationRecord {
  return { citationId: id, url, title: id, sourceType: "web" };
}

function toolCitation(id: string, url: string): ChatCitationRecord {
  return { citationId: id, url, title: id, sourceType: "tool" };
}

function run(toolName: string, url: string, status: ChatToolRunRecord["status"] = "executed"): ChatToolRunRecord {
  return {
    toolRunId: `run-${toolName}-${url}`,
    turnId: "turn-1",
    sessionId: "session-1",
    toolName,
    status,
    startedAt: "2026-10-21T00:00:00.000Z",
    args: { url },
  };
}

const ids = (citations: readonly ChatCitationRecord[]) => citations.map((citation) => citation.citationId);

describe("selectAnswerCitations", () => {
  it("always keeps non-web citations", () => {
    const result = selectAnswerCitations({
      citations: [
        toolCitation("ctx", "goatcitadel://context/receipt-1"),
        webCitation("w1", "https://a.com/one"),
        webCitation("w2", "https://b.com/two"),
      ],
      assistantContent: "See https://a.com/one for details.",
      toolRuns: [],
    });
    expect(ids(result)).toEqual(["ctx", "w1"]);
  });

  it("keeps web citations whose URL appears in the answer, ignoring trailing slash, fragment, and www.", () => {
    const result = selectAnswerCitations({
      citations: [
        webCitation("slash", "https://a.com/one/"),
        webCitation("frag", "https://b.com/two#section"),
        webCitation("www", "https://www.c.com/three"),
        webCitation("unused", "https://d.com/four"),
      ],
      assistantContent:
        "Sources: https://a.com/one, [b](https://b.com/two), and https://c.com/three. Also (https://www.a.com/one#top).",
      toolRuns: [],
    });
    expect(ids(result)).toEqual(["slash", "frag", "www"]);
  });

  it("does not match a URL that only shares a prefix with a cited one", () => {
    const result = selectAnswerCitations({
      citations: [webCitation("short", "https://a.com/x"), webCitation("long", "https://a.com/xyz")],
      assistantContent: "Read https://a.com/xyz.",
      toolRuns: [],
    });
    expect(ids(result)).toEqual(["long"]);
  });

  it("falls back to opened-page citations when the answer names no cited URL", () => {
    const result = selectAnswerCitations({
      citations: [
        webCitation("s1", "https://a.com/search-hit"),
        webCitation("opened", "https://b.com/page"),
        webCitation("failed", "https://c.com/page"),
        webCitation("s2", "https://d.com/search-hit"),
      ],
      assistantContent: "No links here.",
      toolRuns: [
        run("browser.navigate", "https://www.b.com/page/"),
        run("browser.extract", "https://c.com/page", "failed"),
      ],
    });
    expect(ids(result)).toEqual(["opened"]);
  });

  it("returns the input unchanged when neither the answer nor opened pages identify a web citation", () => {
    const citations = [
      toolCitation("ctx", "goatcitadel://context/receipt-1"),
      webCitation("s1", "https://a.com/one"),
      webCitation("s1-dup", "https://a.com/one/"),
      webCitation("s2", "https://b.com/two"),
    ];
    const result = selectAnswerCitations({
      citations,
      assistantContent: "An answer without links.",
      toolRuns: [run("web.search", "https://a.com/one")],
    });
    expect(result).toEqual(citations);
  });

  it("deduplicates by normalized URL, keeping the first", () => {
    const result = selectAnswerCitations({
      citations: [
        webCitation("first", "https://a.com/one"),
        webCitation("second", "https://www.a.com/one/"),
        webCitation("third", "https://a.com/one#x"),
        webCitation("other", "https://b.com/two"),
      ],
      assistantContent: "Both https://a.com/one and https://b.com/two.",
      toolRuns: [],
    });
    expect(ids(result)).toEqual(["first", "other"]);
  });

  it("keeps opened-page citations when the answer cites by number", () => {
    const searchCitations = Array.from({ length: 6 }, (_, index) =>
      webCitation(`search-${index + 1}`, `https://results${index + 1}.example/hit`),
    );
    const opened = webCitation("opened", "https://postgresql.org/docs/current/feature.html");
    const result = selectAnswerCitations({
      citations: [...searchCitations, opened],
      assistantContent: "Postgres supports it [1].",
      toolRuns: [run("browser.navigate", "https://postgresql.org/docs/current/feature.html")],
    });
    expect(result).toEqual([opened]);
  });
});
