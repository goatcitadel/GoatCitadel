import { describe, expect, it } from "vitest";
import {
  annotateLocalBusinessBrowserResult,
  buildLocalBusinessResearchPlan,
  resolveLocalBusinessSearchQuery,
} from "./local-business-research-service.js";

const ORIGINAL_91303_PROMPT =
  "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?";

describe("local-business-research-service", () => {
  it("builds a deterministic source-verification plan for the 91303 boardgame prompt", () => {
    const plan = buildLocalBusinessResearchPlan(ORIGINAL_91303_PROMPT);

    expect(plan).toMatchObject({
      location: "91303",
      radiusMiles: 10,
      categories: expect.arrayContaining(["board game and tabletop game store"]),
      requireEmail: true,
      requireContactName: true,
    });
    expect(plan?.primaryQuery).toBe(
      "board game and tabletop game store 91303 Canoga Park Woodland Hills Winnetka 10 miles official contact email",
    );
    expect(plan?.optionalProviders).toEqual(["google_places", "bing_local", "yelp_fusion"]);
    expect(plan?.evidenceRequirements.join(" ")).toMatch(/Verify business identity and address/);
  });

  it("strips delegation wrapper text and malformed quotes from Cowork search queries", () => {
    const wrappedPrompt = [
      "Delegated role: Researcher",
      `Parent objective: ${ORIGINAL_91303_PROMPT}`,
      "Current step objective: Execute the main workstream using browser.search.",
      "Suggested tools: browser.search, browser.navigate",
    ].join("\n");

    const query = resolveLocalBusinessSearchQuery(
      wrappedPrompt,
      'Delegated role: Researcher "Execute the main workstream" Yelp boardgame stores"',
    );

    expect(query).toBe(
      "board game and tabletop game store 91303 Canoga Park Woodland Hills Winnetka 10 miles official contact email",
    );
    expect(query).not.toMatch(/Delegated role|Execute the main workstream|Suggested tools|"/i);
  });

  it("returns source-backed partial candidates and blockers instead of fabricated contacts", () => {
    const annotated = annotateLocalBusinessBrowserResult({
      toolName: "browser.search",
      args: { query: "board game store 91303 official contact email" },
      userContent: ORIGINAL_91303_PROMPT,
      result: {
        results: [
          {
            title: "Game N Grounds - Contact Us",
            url: "https://gamengrounds.example/contact",
            snippet: "Game N Grounds serves Canoga Park, CA 91303. Visit our store contact page.",
          },
          {
            title: "Board Game Stores near Canoga Park - Yelp",
            url: "https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303",
            snippet: "Local listings.",
          },
        ],
        fallbackChain: [{ error: "Yelp returned 403" }],
      },
    });

    expect(annotated.localBusinessResearch).toMatchObject({
      kind: "local_business_contact_research",
      candidates: [
        expect.objectContaining({
          storeName: "Game N Grounds",
          verificationStatus: "partial",
          website: "https://gamengrounds.example/contact",
          blockers: ["email_not_verified_from_search_result", "contact_name_not_verified_from_search_result"],
          evidence: expect.arrayContaining([
            expect.objectContaining({ evidenceKind: "identity" }),
            expect.objectContaining({ evidenceKind: "address" }),
          ]),
        }),
      ],
      excluded: [
        expect.objectContaining({
          reason: "blocked_or_secondary_listing_source",
          sourceUrl: "https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303",
        }),
      ],
      blockers: ["Yelp returned 403"],
    });
  });
});
