import { describe, expect, it } from "vitest";
import {
  annotateLocalBusinessBrowserResult,
  buildLocalBusinessResearchAnnotationFromEvidence,
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
    expect(plan?.primaryQuery).toBe("Canoga Park 91303 TCG contact game store official email 10 mile radius");
    expect(plan?.optionalProviders).toEqual(["google_places", "bing_local", "yelp_fusion"]);
    expect(plan?.evidenceRequirements.join(" ")).toMatch(/Verify business identity and address/);
  });

  it("keeps every local-business query grounded to the 91303 ZIP, city hints, and radius", () => {
    const plan = buildLocalBusinessResearchPlan(ORIGINAL_91303_PROMPT);

    const queries = [plan?.primaryQuery, ...(plan?.alternateQueries ?? [])].filter((query): query is string =>
      Boolean(query),
    );

    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) {
      expect(query).toContain("91303");
      expect(query).toMatch(/Canoga Park|Woodland Hills|Winnetka/);
      expect(query).toContain("10 mile radius");
    }
  });

  it("builds reusable local-business plans outside the 91303 boardgame case", () => {
    const plan = buildLocalBusinessResearchPlan(
      "Find restaurants near 77001 and get contact email addresses for the manager.",
    );

    expect(plan).toMatchObject({
      location: "77001",
      categories: expect.arrayContaining(["restaurant"]),
      requireEmail: true,
      requireContactName: true,
    });
    const allQueries = [plan?.primaryQuery, ...(plan?.alternateQueries ?? [])].filter(Boolean).join(" ");
    expect(allQueries).toContain("77001");
    expect(allQueries).not.toContain("CA");
  });

  it("accepts useful raw queries grounded to arbitrary ZIP codes", () => {
    const query = resolveLocalBusinessSearchQuery(
      "Find coffee shops near 90210 and collect official contact email addresses.",
      "90210 official cafe contact",
    );

    expect(query).toBe("90210 official cafe contact");
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

    expect(query).toBe("Canoga Park 91303 TCG contact game store official email 10 mile radius");
    expect(query).not.toMatch(/Delegated role|Execute the main workstream|Suggested tools|"/i);
  });

  it("merges useful locationless raw queries into the deterministic local-business plan", () => {
    const query = resolveLocalBusinessSearchQuery(ORIGINAL_91303_PROMPT, "tabletop stores email");

    expect(query).toBe("Canoga Park 91303 TCG contact game store official email 10 mile radius tabletop stores email");
    expect(query).toContain("91303");
    expect(query).toContain("Canoga Park");
    expect(query).toContain("10 mile radius");
  });

  it("preserves planned location anchors for other useful raw queries without location terms", () => {
    const query = resolveLocalBusinessSearchQuery(ORIGINAL_91303_PROMPT, "Magic the Gathering stores email");

    expect(query).toContain("Canoga Park 91303 TCG contact game store official email 10 mile radius");
    expect(query).toContain("Magic the Gathering stores email");
  });

  it("accepts raw queries with planned location and category terms after sanitization", () => {
    const query = resolveLocalBusinessSearchQuery(
      ORIGINAL_91303_PROMPT,
      '"boardgame stores 91303 official contact email"',
    );

    expect(query).toBe("boardgame stores 91303 official contact email");
  });

  it("accepts raw queries grounded by mapped city and category terms after quote cleanup", () => {
    const query = resolveLocalBusinessSearchQuery(
      ORIGINAL_91303_PROMPT,
      'Canoga Park tabletop game stores contact email"',
    );

    expect(query).toBe("Canoga Park tabletop game stores contact email");
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
      workflow: "local_business.research",
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "query_plan", status: "complete" }),
        expect.objectContaining({ name: "candidate_discovery", status: "complete" }),
        expect.objectContaining({ name: "candidate_normalization", status: "complete" }),
        expect.objectContaining({ name: "evidence_navigation", status: "complete" }),
        expect.objectContaining({ name: "contact_extraction", status: "partial" }),
        expect.objectContaining({ name: "verification_scoring", status: "partial" }),
        expect.objectContaining({ name: "blockers", status: "blocked" }),
      ]),
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
    expect(annotated.localBusinessResearch).toMatchObject({
      candidates: [
        expect.not.objectContaining({
          sourceUrls: expect.arrayContaining([
            "https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303",
          ]),
        }),
      ],
    });
  });

  it("rejects ambiguous single-word weak leads instead of treating them as candidates", () => {
    const annotated = annotateLocalBusinessBrowserResult({
      toolName: "browser.search",
      args: { query: "board game store 91303 contact email" },
      userContent: ORIGINAL_91303_PROMPT,
      result: {
        results: [
          {
            title: "Quest",
            url: "https://directory.example/quest",
            snippet: "A local lead near Canoga Park, CA 91303.",
          },
        ],
      },
    });

    expect(annotated.localBusinessResearch).toMatchObject({
      candidates: [],
      excluded: [
        expect.objectContaining({
          reason: "weak_ambiguous_business_identity",
          sourceUrl: "https://directory.example/quest",
        }),
      ],
      blockers: ["weak_ambiguous_business_identities_only"],
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "candidate_normalization", status: "blocked" }),
        expect.objectContaining({ name: "blockers", status: "blocked" }),
      ]),
    });
  });

  it("excludes search leads without source-backed location evidence from candidate rows", () => {
    const annotated = annotateLocalBusinessBrowserResult({
      toolName: "browser.search",
      args: { query: "board game store 91303 contact email" },
      userContent: ORIGINAL_91303_PROMPT,
      result: {
        results: [
          {
            title: "Board game - Online whiteboard",
            url: "https://board.example/features/games",
            snippet: "A browser-based collaborative whiteboard for teams.",
          },
          {
            title: "Game N Grounds - Contact Us",
            url: "https://gamengrounds.example/contact",
            snippet: "Game N Grounds is a tabletop game store in Canoga Park, CA 91303.",
          },
        ],
      },
    });

    expect(annotated.localBusinessResearch).toMatchObject({
      candidates: [
        expect.objectContaining({
          storeName: "Game N Grounds",
          verificationStatus: "partial",
        }),
      ],
      excluded: [
        expect.objectContaining({
          reason: "location_not_verified_from_search_result",
          sourceUrl: "https://board.example/features/games",
        }),
      ],
    });
    expect(annotated.localBusinessResearch?.candidates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceUrls: ["https://board.example/features/games"] })]),
    );
  });

  it("keeps Yelp, Facebook, and Instagram as blocked secondary listing-only evidence", () => {
    const annotated = annotateLocalBusinessBrowserResult({
      toolName: "browser.search",
      args: { query: "board game store 91303 contact email" },
      userContent: ORIGINAL_91303_PROMPT,
      result: {
        results: [
          {
            title: "Board Game Stores near Canoga Park - Yelp",
            url: "https://www.yelp.com/search?find_desc=board+game+stores&find_loc=91303",
            snippet: "Local listings.",
          },
          {
            title: "Game N Grounds | Facebook",
            url: "https://www.facebook.com/gamengrounds",
            snippet: "Game N Grounds posts and community updates.",
          },
          {
            title: "Game N Grounds on Instagram",
            url: "https://www.instagram.com/gamengrounds",
            snippet: "Photos and reels.",
          },
        ],
      },
    });

    expect(annotated.localBusinessResearch).toMatchObject({
      candidates: [],
      blockers: ["blocked_or_secondary_listing_sources_only"],
      excluded: [
        expect.objectContaining({ reason: "blocked_or_secondary_listing_source" }),
        expect.objectContaining({ reason: "blocked_or_secondary_listing_source" }),
        expect.objectContaining({ reason: "blocked_or_secondary_listing_source" }),
      ],
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "evidence_navigation", status: "blocked" }),
        expect.objectContaining({ name: "contact_extraction", status: "blocked" }),
      ]),
    });
  });

  it("verifies email and contact name only from source-backed official contact evidence", () => {
    const annotated = annotateLocalBusinessBrowserResult({
      toolName: "browser.search",
      args: { query: "board game store 91303 official contact email" },
      userContent: ORIGINAL_91303_PROMPT,
      result: {
        results: [
          {
            title: "Game N Grounds - Contact",
            url: "https://gamengrounds.example/contact",
            snippet:
              "Game N Grounds is a tabletop game store in Canoga Park, CA 91303. Owner: Alex Rivera. Email alex@gamengrounds.example.",
          },
          {
            title: "Board Game Stores near Canoga Park - Yelp",
            url: "https://www.yelp.com/biz/game-n-grounds",
            snippet: "Owner: Listing Person. Email listing@example.com.",
          },
        ],
      },
    });

    expect(annotated.localBusinessResearch).toMatchObject({
      candidates: [
        expect.objectContaining({
          storeName: "Game N Grounds",
          email: "alex@gamengrounds.example",
          contactName: "Alex Rivera",
          contactRole: "owner",
          verificationStatus: "verified",
          confidence: "high",
          blockers: [],
          evidence: expect.arrayContaining([
            expect.objectContaining({ evidenceKind: "email", confidence: "high" }),
            expect.objectContaining({ evidenceKind: "contact_name", confidence: "high" }),
          ]),
        }),
      ],
      excluded: [
        expect.objectContaining({
          reason: "blocked_or_secondary_listing_source",
          sourceUrl: "https://www.yelp.com/biz/game-n-grounds",
        }),
      ],
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "contact_extraction", status: "complete" }),
        expect.objectContaining({ name: "verification_scoring", status: "complete" }),
      ]),
    });
  });

  it("retains source-backed final-answer evidence as structured local-business research", () => {
    const annotation = buildLocalBusinessResearchAnnotationFromEvidence({
      userContent: ORIGINAL_91303_PROMPT,
      finalAnswer: [
        "- Cash Cards Unlimited - info@cashcardsunlimited.com; no named contact verified.",
        "- Fire & Dice Games - fire.dice.games@gmail.com; no named contact verified.",
        "- Warhammer Woodland Hills - blocked by human verification; public email not verified.",
      ].join("\n"),
      citations: [
        {
          title: "Cash Cards Unlimited - Contact",
          url: "https://cashcardsunlimited.example/contact",
          snippet:
            "Cash Cards Unlimited is a game and card store near Canoga Park, CA 91303. Contact: info@cashcardsunlimited.com.",
        },
        {
          title: "Fire & Dice Games - Contact",
          url: "https://firedicegames.example/contact",
          snippet:
            "Fire & Dice Games serves Woodland Hills near 91303. Public contact email fire.dice.games@gmail.com.",
        },
        {
          title: "Warhammer store locator",
          url: "https://www.warhammer.com/en-US/store/warhammer-woodland-hills",
          snippet: "Human verification required.",
        },
      ],
    });

    expect(annotation).toMatchObject({
      kind: "local_business_contact_research",
      workflow: "local_business.research",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          storeName: "Cash Cards Unlimited",
          email: "info@cashcardsunlimited.com",
          verificationStatus: "partial",
          blockers: expect.arrayContaining(["contact_name_not_verified_from_search_result"]),
        }),
        expect.objectContaining({
          storeName: "Fire & Dice Games",
          email: "fire.dice.games@gmail.com",
          verificationStatus: "partial",
        }),
      ]),
      stages: expect.arrayContaining([
        expect.objectContaining({ name: "candidate_discovery", status: "complete" }),
        expect.objectContaining({ name: "contact_extraction", status: "partial" }),
        expect.objectContaining({ name: "blockers", status: "blocked" }),
      ]),
    });
    expect(annotation?.blockers.join(" ")).toContain("research_evidence_incomplete");
  });

  it("does not treat final-answer emails as verified unless source text contains the exact email", () => {
    const annotation = buildLocalBusinessResearchAnnotationFromEvidence({
      userContent: ORIGINAL_91303_PROMPT,
      finalAnswer: "- Cash Cards Unlimited - info@cashcardsunlimited.com; no named contact verified.",
      citations: [
        {
          title: "Cash Cards Unlimited - Contact",
          url: "https://cashcardsunlimited.example/contact",
          snippet: "Cash Cards Unlimited is a game and card store near Canoga Park, CA 91303.",
        },
      ],
    });

    expect(annotation?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storeName: "Cash Cards Unlimited",
          email: undefined,
          verificationStatus: "partial",
          blockers: expect.arrayContaining([
            "email_not_verified_from_search_result",
            "email_not_verified_from_source_text",
          ]),
        }),
      ]),
    );
  });
});
