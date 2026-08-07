export const CCG_CORE_GAMES = [
  { name: "Magic: The Gathering", sourceId: "magic" },
  { name: "Pokémon Trading Card Game", sourceId: "pokemon" },
  { name: "Yu-Gi-Oh! Trading Card Game", sourceId: "yugioh" },
  { name: "One Piece Card Game", sourceId: "one-piece" },
  { name: "Disney Lorcana", sourceId: "lorcana" },
  { name: "Flesh and Blood", sourceId: "fab" },
  { name: "Star Wars: Unlimited", sourceId: "swu" },
  { name: "Riftbound", sourceId: "riftbound" },
  { name: "Gundam Card Game", sourceId: "gundam" },
];

export function buildCcgResearchDeckFixture(index) {
  const retrievedAt = "2026-08-06";
  return {
    path: `./workspace/artifacts/ccg-market-reliability-${index}.pptx`,
    title: "CCG Competitive Landscape 2026: Best Fits for Players and Retailers",
    subtitle: "North American physical-card comparison with global scale context · Research as of August 6, 2026",
    theme: "midnight teal",
    design: { mode: "polished", skillId: "design-intelligence" },
    research: buildResearchMetadata(),
    sources: buildSources(retrievedAt),
    slides: buildSlides(),
  };
}

export function extractFixtureVisibleText(args) {
  const text = [args.title, args.subtitle];
  for (const slide of args.slides ?? []) {
    text.push(slide.title);
    for (const bullet of slide.bullets ?? []) text.push(typeof bullet === "string" ? bullet : bullet.text);
    for (const header of slide.table?.headers ?? []) text.push(typeof header === "string" ? header : header.text);
    for (const row of slide.table?.rows ?? []) {
      for (const cell of row) text.push(typeof cell === "string" ? cell : cell.text);
    }
    for (const category of slide.chart?.categories ?? []) text.push(category);
    for (const series of slide.chart?.series ?? []) text.push(series.name);
  }
  return text.filter((value) => typeof value === "string" && value.trim());
}

export function extractFixtureSourceUrls(args) {
  return (args.sources ?? []).map((source) => source.url);
}

function buildResearchMetadata() {
  return {
    asOfDate: "2026-08-06",
    geography: "North America, with global scale context where official sources support it",
    physicalDigitalBoundary:
      "Core comparison covers physical collectible card games; digital clients and digital-native substitutes are separated.",
    inclusionCriteria: [
      "Active North American physical product availability or announced launch support",
      "Official organized-play or community-play support",
      "Distinct player proposition relevant to tabletop retailers",
    ],
    exclusions: [
      "Digital-only games are excluded from the physical comparison matrix",
      "Digimon, Dragon Ball Super Card Game Fusion World, and Union Arena remain on the watchlist pending equal evidence depth",
    ],
    methodology: [
      "Use official sources for product, rules, and organized-play claims",
      "Use independent, marketplace, or financial evidence only for cross-category signals",
      "Apply the same qualitative player and retailer criteria to every core game",
    ],
    limitations: [
      "Public sources do not expose comparable revenue, player-count, inventory-turn, or singles-liquidity data for every game",
      "Retail outcomes vary by allocation, geography, staff expertise, and local community composition",
    ],
    competitors: CCG_CORE_GAMES.map((game) => game.name),
    comparisonCriteria: [
      "Signature mechanics and player benefit",
      "Learning curve and strategic depth",
      "Dated entry-product and ongoing cost, or explicit not measured",
      "Intellectual-property and collectibility appeal",
      "Format and organized-play support",
      "Local-play and digital accessibility",
      "Retail demand and community-building potential",
      "Release or SKU burden, singles liquidity, and inventory risk",
      "Best-fit audience and major trade-off",
    ],
  };
}

function buildSources(retrievedAt) {
  return [
    source(
      "magic",
      "Magic product catalog",
      "https://magic.wizards.com/en/products",
      "Wizards of the Coast",
      "official",
      retrievedAt,
    ),
    source(
      "pokemon",
      "Pokémon Trading Card Game",
      "https://www.pokemon.com/us/pokemon-tcg/",
      "The Pokémon Company",
      "official",
      retrievedAt,
    ),
    source(
      "yugioh",
      "Yu-Gi-Oh! Trading Card Game",
      "https://www.yugioh-card.com/en/",
      "Konami",
      "official",
      retrievedAt,
    ),
    source("one-piece", "One Piece Card Game", "https://en.onepiece-cardgame.com/", "Bandai", "official", retrievedAt),
    source(
      "lorcana",
      "Disney Lorcana",
      "https://www.disneylorcana.com/en-US/",
      "Ravensburger",
      "official",
      retrievedAt,
    ),
    source("fab", "Flesh and Blood", "https://fabtcg.com/en/", "Legend Story Studios", "official", retrievedAt),
    source(
      "swu",
      "Star Wars: Unlimited",
      "https://starwarsunlimited.com/",
      "Fantasy Flight Games",
      "official",
      retrievedAt,
    ),
    source(
      "riftbound",
      "Riftbound",
      "https://riftbound.leagueoflegends.com/en-us/",
      "Riot Games",
      "official",
      retrievedAt,
    ),
    source("gundam", "Gundam Card Game", "https://www.gundam-gcg.com/en/", "Bandai", "official", retrievedAt),
    source(
      "tcgplayer",
      "Trading and collectible card game marketplace",
      "https://www.tcgplayer.com/categories/trading-and-collectible-card-games",
      "TCGplayer",
      "marketplace",
      retrievedAt,
    ),
    source("icv2", "Collectible game market reporting", "https://icv2.com/", "ICv2", "independent", retrievedAt),
    source("hasbro", "Hasbro investor relations", "https://investor.hasbro.com/", "Hasbro", "financial", retrievedAt),
    source(
      "pocket",
      "Pokémon Trading Card Game Pocket",
      "https://tcgpocket.pokemon.com/en-us/",
      "The Pokémon Company",
      "official",
      retrievedAt,
    ),
    source(
      "hearthstone",
      "Hearthstone",
      "https://hearthstone.blizzard.com/",
      "Blizzard Entertainment",
      "official",
      retrievedAt,
    ),
    source("snap", "Marvel Snap", "https://www.marvelsnap.com/", "Second Dinner", "official", retrievedAt),
  ];
}

function buildSlides() {
  return [
    {
      title: "Bottom line: different winners for different jobs",
      archetype: "comparison",
      bullets: [
        claim(
          "Recommendation: For broad-format choice, consider Magic; for family-and-collector entry, consider Pokémon.",
          "recommendation",
          ["magic", "pokemon", "hasbro"],
        ),
        claim(
          "Recommendation: For specialist tactical duels, consider Flesh and Blood; for approachable licensed-IP entry, consider Lorcana.",
          "recommendation",
          ["fab", "lorcana"],
        ),
        claim(
          "Recommendation: Consider One Piece, Star Wars: Unlimited, Riftbound, or Gundam only where local fandom can become recurring store play.",
          "recommendation",
          ["one-piece", "swu", "riftbound", "gundam"],
        ),
        claim(
          "Recommendation: Start with fewer lines when a store cannot support rules expertise or measured inventory bets, then validate local demand before expanding.",
          "recommendation",
          [],
        ),
      ],
    },
    {
      title: "Scope, inclusion, and evidence limits",
      archetype: "narrative",
      bullets: [
        claim(
          "The core set contains nine physical games with North American product and organized-play evidence.",
          "fact",
          [...coreSourceIds(), "tcgplayer", "icv2"],
        ),
        claim(
          "Official sources support game-specific claims; ICv2, TCGplayer, and Hasbro provide limited cross-category context.",
          "fact",
          ["icv2", "tcgplayer", "hasbro"],
        ),
        claim(
          "No universal market-share, active-player, inventory-turn, or liquidity ranking is asserted because comparable public data is incomplete.",
          "analysis",
          ["icv2", "tcgplayer", "hasbro"],
        ),
      ],
    },
    {
      title: "Official product-evidence coverage as of 2026-08-06",
      archetype: "chart",
      bullets: [
        claim(
          "Publisher reporting confirms Magic remains strategically material to Hasbro, but equivalent financial disclosure is unavailable for every competitor.",
          "fact",
          ["hasbro"],
        ),
        claim(
          "Marketplace breadth shows demand across established and licensed challengers, but listings are not audited sales or store-level turns.",
          "analysis",
          ["tcgplayer"],
        ),
        claim(
          "Trade reporting supports continued collectible-game activity while leaving game-by-game comparisons incomplete.",
          "analysis",
          ["icv2"],
        ),
        claim(
          "Observed as of 2026-08-06, the chart records one official product source for each core game; it measures evidence coverage, not demand.",
          "fact",
          [...coreSourceIds(), "tcgplayer", "icv2"],
        ),
      ],
      chart: {
        type: "bar",
        categories: CCG_CORE_GAMES.map((game) => game.name),
        series: [
          {
            name: "Official product source observed per core game as of 2026-08-06",
            values: CCG_CORE_GAMES.map(() => 1),
            sourceIds: [...coreSourceIds(), "tcgplayer", "icv2"],
          },
        ],
      },
    },
    {
      title: "One rubric for every game",
      archetype: "matrix",
      table: {
        headers: rubricCells("Dimension", "Low", "Moderate", "High"),
        rows: [
          rubricCells("Learning curve", "Quick first game", "Guidance helps", "Rules expertise expected"),
          rubricCells(
            "Strategic depth",
            "Focused decision space",
            "Layered mastery",
            "Broad formats or dense interactions",
          ),
          rubricCells("Retail burden", "Narrow line", "Set-led planning", "Broad releases or specialist inventory"),
          rubricCells(
            "Community potential",
            "Niche local fit",
            "Fandom or events can compound",
            "Multiple recurring audiences",
          ),
        ],
      },
      bullets: [
        claim(
          "Ratings are qualitative syntheses, not fabricated scores; each row must be read with its cited trade-off.",
          "analysis",
          ["icv2", "tcgplayer"],
        ),
      ],
    },
    {
      title: "Established category anchors",
      archetype: "section",
      visualBrief: "Abstract tabletop cards arranged as three strategic systems, with no logos or readable text",
      bullets: [
        claim(
          "Magic pairs modular deck construction with long-running format breadth, rewarding mastery while raising onboarding and inventory complexity.",
          "analysis",
          ["magic", "hasbro"],
        ),
        claim(
          "Pokémon pairs an accessible prize race with recognized characters, creating a strong player-and-collector gateway.",
          "analysis",
          ["pokemon"],
        ),
        claim(
          "Yu-Gi-Oh! emphasizes fast sequencing and dense interactions, rewarding specialists while demanding more rules support.",
          "analysis",
          ["yugioh"],
        ),
      ],
    },
    {
      title: "IP- and collectibility-led challengers",
      archetype: "comparison",
      bullets: [
        claim(
          "One Piece converts leader identity and a managed resource curve into a competitive game with direct anime-fandom pull.",
          "analysis",
          ["one-piece"],
        ),
        claim(
          "Disney Lorcana uses questing and familiar characters to lower the social barrier for families and licensed-IP collectors.",
          "analysis",
          ["lorcana"],
        ),
        claim(
          "Star Wars: Unlimited combines initiative decisions and two arenas with the Star Wars setting.",
          "analysis",
          ["swu"],
        ),
      ],
    },
    {
      title: "Competitive and community-led specialist",
      archetype: "section",
      bullets: [
        claim(
          "Flesh and Blood centers combat around a persistent hero and equipment, producing a highly tactical duel identity.",
          "analysis",
          ["fab"],
        ),
        claim(
          "Its focused proposition can deepen repeat play, but it depends more heavily on a committed specialist community.",
          "analysis",
          ["fab", "icv2"],
        ),
        claim(
          "Recommendation: Test Flesh and Blood with event-linked inventory when a store can sustain recurring competitive play.",
          "recommendation",
          [],
        ),
      ],
    },
    {
      title: "Recent entrants and watchlist",
      archetype: "comparison",
      visualBrief:
        "Two emerging tabletop card systems entering a store community, with neutral geometric cards and no logos",
      bullets: [
        claim(
          "Riftbound brings League of Legends familiarity to a physical battlefield-control game with an early organized-play roadmap.",
          "analysis",
          ["riftbound"],
        ),
        claim(
          "Gundam Card Game combines unit-and-pilot synergies with a franchise that can cross over from model-kit and anime communities.",
          "analysis",
          ["gundam"],
        ),
        claim(
          "Digimon, Fusion World, and Union Arena remain a watchlist because this benchmark lacks equal evidence for every rubric field.",
          "analysis",
          ["icv2", "tcgplayer"],
        ),
      ],
    },
    {
      title: "Physical CCG matrix: player proposition",
      archetype: "matrix",
      table: {
        headers: matrixHeaders([
          "Game",
          "Mechanics / benefit",
          "Learning / depth",
          "Cost signal",
          "IP / collecting",
          "Local / digital access",
        ]),
        rows: playerMatrixRows(),
      },
    },
    {
      title: "Physical CCG matrix: retailer proposition",
      archetype: "matrix",
      table: {
        headers: matrixHeaders([
          "Game",
          "Formats / events",
          "Demand / community",
          "Release burden",
          "Singles liquidity",
          "Conditional fit / trade-off",
        ]),
        rows: retailerMatrixRows(),
      },
    },
    {
      title: "Player fit guide",
      archetype: "comparison",
      bullets: [
        claim(
          "Recommendation: For family learning and collecting, compare Pokémon with Lorcana; familiar characters lower interest barriers, while availability can vary.",
          "recommendation",
          ["pokemon", "lorcana"],
        ),
        claim(
          "Recommendation: For broad format exploration, start with Magic and accept a denser rules and product landscape.",
          "recommendation",
          ["magic"],
        ),
        claim(
          "Recommendation: For tactical mastery around a hero, choose Flesh and Blood after confirming a repeat local opponent group.",
          "recommendation",
          ["fab"],
        ),
        claim(
          "Recommendation: For licensed-world play, compare One Piece, Star Wars: Unlimited, Riftbound, and Gundam, then let local opponents break the tie.",
          "recommendation",
          ["one-piece", "swu", "riftbound", "gundam"],
        ),
      ],
    },
    {
      title: "Retailer fit, inventory considerations, and watch-outs",
      archetype: "comparison",
      bullets: [
        claim(
          "Established lines provide deeper product and community history, but breadth can increase SKU and staff-training burden.",
          "analysis",
          ["magic", "pokemon", "yugioh", "tcgplayer"],
        ),
        claim(
          "Licensed challengers can recruit existing fandoms, but allocation and local conversion to repeat play remain store-specific.",
          "analysis",
          ["one-piece", "lorcana", "swu", "tcgplayer"],
        ),
        claim(
          "Recent entrants should begin as measured tests with reorder, attendance, and sell-through checkpoints.",
          "recommendation",
          [],
        ),
      ],
    },
    {
      title: "Digital clients and digital-native substitutes",
      archetype: "narrative",
      bullets: [
        claim(
          "Pokémon TCG Pocket, Hearthstone, and Marvel Snap are adjacent attention competitors, not physical retail peers.",
          "analysis",
          ["pocket", "hearthstone", "snap"],
        ),
        claim(
          "Official digital clients can lower play friction for physical brands, while digital-native games avoid local-store inventory and event requirements.",
          "analysis",
          ["magic", "pokemon", "yugioh", "pocket", "hearthstone", "snap", "tcgplayer", "icv2"],
        ),
        claim(
          "Retail recommendations should separate digital discovery benefits from physical product economics.",
          "recommendation",
          [],
        ),
      ],
    },
    {
      title: "Conclusions and remaining uncertainty",
      archetype: "closing",
      bullets: [
        claim(
          "Recommendation: Match each game to its audience, local community, staff expertise, play support, and inventory tolerance.",
          "recommendation",
          [],
        ),
        claim("The reviewed evidence does not support a universal winner.", "analysis", [
          "icv2",
          "tcgplayer",
          ...coreSourceIds(),
        ]),
        claim(
          "Public evidence is more complete for product identity and official play support than for comparable store economics.",
          "analysis",
          ["icv2", "tcgplayer", "hasbro"],
        ),
        claim(
          "Recommendation: If this deck informs purchasing, validate qualitative fit against local preorder demand, attendance, and reorder data.",
          "recommendation",
          [],
        ),
      ],
    },
  ];
}

function playerMatrixRows() {
  return [
    matrixRow("Magic: The Gathering", "magic", [
      "Modular deckbuilding",
      "High depth",
      "Not measured comparably as of 2026-08-06",
      "Original fantasy",
      "Local formats plus Arena; complexity remains the trade-off",
    ]),
    matrixRow("Pokémon Trading Card Game", "pokemon", [
      "Accessible prize race",
      "Low entry / layered mastery",
      "Not measured comparably as of 2026-08-06",
      "High character appeal",
      "League plus digital clients; collector demand varies",
    ]),
    matrixRow("Yu-Gi-Oh! Trading Card Game", "yugioh", [
      "Fast combo sequencing",
      "High rules density",
      "Not measured comparably as of 2026-08-06",
      "Anime-led",
      "Local events plus Master Duel; steep onboarding",
    ]),
    matrixRow("One Piece Card Game", "one-piece", [
      "Leader-led resource curve",
      "Moderate depth",
      "Not measured comparably as of 2026-08-06",
      "High licensed appeal",
      "Local play without an equivalent client; availability matters",
    ]),
    matrixRow("Disney Lorcana", "lorcana", [
      "Questing race",
      "Low-to-moderate entry",
      "Not measured comparably as of 2026-08-06",
      "High Disney appeal",
      "Local play without an official client; depth is still growing",
    ]),
    matrixRow("Flesh and Blood", "fab", [
      "Hero equipment combat",
      "High tactical depth",
      "Not measured comparably as of 2026-08-06",
      "Original fantasy",
      "Local-first without an official client; narrower casual reach",
    ]),
    matrixRow("Star Wars: Unlimited", "swu", [
      "Initiative and two arenas",
      "Moderate depth",
      "Not measured comparably as of 2026-08-06",
      "High licensed appeal",
      "Local play without an official client; product continuity matters",
    ]),
    matrixRow("Riftbound", "riftbound", [
      "Battlefield control",
      "Emerging depth",
      "Not measured comparably as of 2026-08-06",
      "League of Legends appeal",
      "Early local roadmap without an official CCG client; short history",
    ]),
    matrixRow("Gundam Card Game", "gundam", [
      "Unit and pilot synergies",
      "Emerging depth",
      "Not measured comparably as of 2026-08-06",
      "Gundam appeal",
      "Early local roadmap without an official client; short regional history",
    ]),
  ];
}

function retailerMatrixRows() {
  return [
    matrixRow("Magic: The Gathering", "magic", [
      "Many established formats",
      "Retail demand not measured; multiple official play communities",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: staff-curated format anchor; trade-off: product and rules breadth",
    ]),
    matrixRow("Pokémon Trading Card Game", "pokemon", [
      "League and family play",
      "Retail demand not measured; league supports community building",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: family and collector traffic; trade-off: demand can outpace allocation",
    ]),
    matrixRow("Yu-Gi-Oh! Trading Card Game", "yugioh", [
      "Established tournaments",
      "Retail demand not measured; tournaments support specialists",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: rules-savvy staff and specialists; trade-off: dense rulings",
    ]),
    matrixRow("One Piece Card Game", "one-piece", [
      "Growing organized play",
      "Retail demand not measured; fandom can seed community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: stores with visible anime fandom; trade-off: supply continuity",
    ]),
    matrixRow("Disney Lorcana", "lorcana", [
      "Accessible store events",
      "Retail demand not measured; accessible events can build community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: gateway events; trade-off: developing competitive depth",
    ]),
    matrixRow("Flesh and Blood", "fab", [
      "Competitive local events",
      "Retail demand not measured; events can deepen specialist community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: competitive communities; trade-off: narrower casual reach",
    ]),
    matrixRow("Star Wars: Unlimited", "swu", [
      "Structured store play",
      "Retail demand not measured; licensed IP can seed community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: stores where Star Wars recruits; trade-off: product continuity",
    ]),
    matrixRow("Riftbound", "riftbound", [
      "Early play roadmap",
      "Retail demand not measured; League fandom may seed community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: measured allocation test; trade-off: limited operating history",
    ]),
    matrixRow("Gundam Card Game", "gundam", [
      "Early play roadmap",
      "Retail demand not measured; model-kit fandom may seed community",
      "SKU burden not measured comparably",
      "Singles liquidity not measured comparably",
      "Fit: stores with visible Gundam fandom; trade-off: limited regional history",
    ]),
  ];
}

function source(id, title, url, publisher, role, retrievedAt) {
  return { id, title, url, publisher, role, retrievedAt };
}

function claim(text, claimKind, sourceIds) {
  return { text, claimKind, sourceIds };
}

function matrixRow(game, sourceId, values) {
  return [{ text: game, sourceIds: [sourceId] }, ...values.map((text) => ({ text, sourceIds: [sourceId] }))];
}

function matrixHeaders(values) {
  return values.map((text) => ({ text, sourceIds: coreSourceIds() }));
}

function rubricCells(...values) {
  return values.map((text) => ({ text, sourceIds: ["icv2", "tcgplayer"] }));
}

function coreSourceIds() {
  return CCG_CORE_GAMES.map((game) => game.sourceId);
}
