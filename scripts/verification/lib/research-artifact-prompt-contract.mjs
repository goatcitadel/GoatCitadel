const REQUIRED_SCOPE_FIELDS = [
  "inclusionCriteria",
  "exclusions",
  "methodology",
  "limitations",
  "competitors",
  "comparisonCriteria",
];

const INDEPENDENT_SOURCE_ROLES = new Set(["independent", "retailer", "marketplace", "event", "financial"]);

const REQUIRED_CORE_GAMES = [
  {
    label: "Magic: The Gathering",
    aliases: ["magic", "magic the gathering", "mtg"],
    officialDomains: ["magic.wizards.com", "wizards.com"],
  },
  {
    label: "Pokémon Trading Card Game",
    aliases: ["pokemon", "pokemon trading card game", "pokemon tcg"],
    officialDomains: ["pokemon.com"],
  },
  {
    label: "Yu-Gi-Oh! Trading Card Game",
    aliases: ["yugioh", "yu gi oh", "yu gi oh trading card game"],
    officialDomains: ["yugioh-card.com", "konami.com"],
  },
  {
    label: "One Piece Card Game",
    aliases: ["one piece", "one piece card game", "onepiece"],
    officialDomains: ["onepiece-cardgame.com"],
  },
  {
    label: "Disney Lorcana",
    aliases: ["lorcana", "disney lorcana"],
    officialDomains: ["disneylorcana.com", "ravensburger.com"],
  },
  {
    label: "Flesh and Blood",
    aliases: ["flesh and blood", "fab", "fabtcg"],
    officialDomains: ["fabtcg.com"],
  },
  {
    label: "Star Wars: Unlimited",
    aliases: ["star wars unlimited", "starwarsunlimited", "swu"],
    officialDomains: ["starwarsunlimited.com", "fantasyflightgames.com"],
  },
  {
    label: "Riftbound",
    aliases: ["riftbound"],
    officialDomains: ["riftbound.leagueoflegends.com", "leagueoflegends.com", "riotgames.com"],
  },
  {
    label: "Gundam Card Game",
    aliases: ["gundam", "gundam card game"],
    officialDomains: ["gundam-gcg.com"],
  },
];

const REQUIRED_MATRIX_FIELDS = [
  { id: "mechanicsBenefit", pattern: /mechanic|gameplay|player\s+benefit/iu },
  { id: "learningDepth", pattern: /learning|strategic\s+depth|depth/iu },
  { id: "costSignal", pattern: /cost|price|entry\s+product/iu, requiresNotMeasured: true, requiresDate: true },
  { id: "ipCollecting", pattern: /\bip\b|collect|franchise/iu },
  { id: "localDigitalAccess", pattern: /local|digital|access/iu },
  { id: "formatsOrganizedPlay", pattern: /format|organized\s+play|events?/iu },
  { id: "demandCommunity", pattern: /demand|community/iu, requiresNotMeasured: true },
  { id: "releaseSkuBurden", pattern: /release|sku|inventory\s+burden/iu, requiresNotMeasured: true },
  { id: "singlesLiquidity", pattern: /singles|liquidity/iu, requiresNotMeasured: true },
  { id: "fitTradeoff", pattern: /\bfit\b|trade[ -]?off/iu },
];

export function assertResearchArtifactPromptDeckSemantics({ prompt, args, acquiredEvidenceUrls = [] }) {
  const report = evaluateResearchArtifactPromptDeckSemantics({ prompt, args, acquiredEvidenceUrls });
  if (!report.passed) {
    throw new Error(
      `Research-artifact prompt contract failed:\n${report.findings.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  return report;
}

export function evaluateResearchArtifactPromptDeckSemantics({ prompt, args, acquiredEvidenceUrls = [] }) {
  const findings = [];
  const intent = derivePromptIntent(prompt, findings);
  const deck = isRecord(args) ? args : {};
  const research = isRecord(deck.research) ? deck.research : {};
  const sources = Array.isArray(deck.sources) ? deck.sources.filter(isRecord) : [];
  const slides = Array.isArray(deck.slides) ? deck.slides.filter(isRecord) : [];

  if (intent.powerPoint && !/\.pptx$/iu.test(readText(deck.path))) {
    findings.push("The requested PowerPoint output does not have a .pptx artifact path.");
  }
  if (intent.ccgMarket && !/ccg|collectible\s+card|trading\s+card/iu.test(readText(deck.title))) {
    findings.push("The deck title does not identify the CCG category.");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(readText(research.asOfDate))) {
    findings.push("Research metadata requires an ISO as-of date.");
  }
  if (!/north\s+america/iu.test(readText(research.geography))) {
    findings.push("Research metadata does not declare the North American geography.");
  }
  if (
    !/physical/iu.test(readText(research.physicalDigitalBoundary)) ||
    !/digital/iu.test(readText(research.physicalDigitalBoundary))
  ) {
    findings.push("Research metadata does not explicitly separate physical and digital games.");
  }
  for (const field of REQUIRED_SCOPE_FIELDS) {
    if (!Array.isArray(research[field]) || research[field].length === 0) {
      findings.push(`Research metadata field ${field} is empty.`);
    }
  }

  const competitors = Array.isArray(research.competitors) ? research.competitors.map(readText).filter(Boolean) : [];
  for (const expected of REQUIRED_CORE_GAMES) {
    if (!competitors.some((competitor) => matchesAliases(competitor, expected.aliases))) {
      findings.push(`The prompt-aligned core comparison is missing ${expected.label}.`);
    }
  }

  const sourceById = new Map();
  const canonicalSourceUrls = new Set();
  const sourceDomains = new Set();
  for (const source of sources) {
    const id = readText(source.id);
    const url = canonicalHttpsUrl(source.url);
    if (!id || !url) continue;
    if (sourceById.has(id)) findings.push(`The structured source registry repeats source ID ${id}.`);
    sourceById.set(id, source);
    canonicalSourceUrls.add(url);
    sourceDomains.add(new URL(url).hostname.toLowerCase());
  }
  if (canonicalSourceUrls.size < 12) findings.push("The CCG research deck has fewer than 12 unique HTTPS sources.");
  if (sourceDomains.size < 8) findings.push("The CCG research deck has sources from fewer than eight domains.");
  const independentCount = sources.filter((source) =>
    INDEPENDENT_SOURCE_ROLES.has(readText(source.role).toLowerCase()),
  ).length;
  if (independentCount < 2)
    findings.push("The CCG research deck has fewer than two independent market or retailer sources.");

  const acquiredUrls = new Set(acquiredEvidenceUrls.map(canonicalHttpsUrl).filter(Boolean));
  const matrixModels = slides.map(readMatrix).filter(Boolean);
  if (matrixModels.length < 2)
    findings.push("The prompt requires the physical comparison to be split across at least two matrices.");
  const fieldLocations = locateRequiredMatrixFields(matrixModels, findings);
  const rowsByCompetitor = new Map();
  for (const competitor of competitors) {
    const matchingRows = matrixModels.flatMap((matrix) =>
      matrix.rows
        .filter((row) => matchesAliases(cellText(row[0]), aliasesForCompetitor(competitor)))
        .map((row) => ({ matrix, row })),
    );
    rowsByCompetitor.set(competitor, matchingRows);
    if (matchingRows.length !== matrixModels.length) {
      findings.push(
        `${competitor} appears in ${matchingRows.length} of ${matrixModels.length} comparison matrices; equal field coverage is required.`,
      );
    }
    for (const { matrix, row } of matchingRows) {
      if (row.length !== matrix.headers.length || row.some((cell) => !cellText(cell))) {
        findings.push(`${competitor} has an incomplete row in ${matrix.title}.`);
      }
    }
  }

  for (const expected of REQUIRED_CORE_GAMES) {
    const competitor = competitors.find((value) => matchesAliases(value, expected.aliases));
    if (!competitor) continue;
    const official = sources.find((source) => isAuthoritativeOfficialSource(source, expected));
    if (!official) {
      findings.push(`${expected.label} lacks a canonical authoritative official source.`);
      continue;
    }
    const officialId = readText(official.id);
    const rows = rowsByCompetitor.get(competitor) ?? [];
    if (!rows.every(({ row }) => row.some((cell) => cellSourceIds(cell).includes(officialId)))) {
      findings.push(`${expected.label} matrix coverage is not linked to its official source.`);
    }
    const officialUrl = canonicalHttpsUrl(official.url);
    if (acquiredUrls.size > 0 && (!officialUrl || !acquiredUrls.has(officialUrl))) {
      findings.push(`${expected.label} official source was not acquired by the deterministic browser evidence run.`);
    }
  }

  for (const [fieldId, location] of fieldLocations) {
    const requirement = REQUIRED_MATRIX_FIELDS.find((field) => field.id === fieldId);
    if (!requirement) continue;
    const observedValues = [];
    for (const competitor of competitors) {
      const match = (rowsByCompetitor.get(competitor) ?? []).find(({ matrix }) => matrix === location.matrix);
      const value = match ? cellText(match.row[location.columnIndex]) : "";
      observedValues.push(value);
      if (!value) continue;
      if (requirement.requiresNotMeasured && !/not\s+measured/iu.test(value)) {
        findings.push(
          `${competitor} ${fieldId} must explicitly say not measured when comparable public data is absent.`,
        );
      }
      if (requirement.requiresDate && !/\b\d{4}-\d{2}-\d{2}\b/u.test(value)) {
        findings.push(`${competitor} ${fieldId} requires a dated signal or dated not-measured statement.`);
      }
    }
    if (fieldId === "mechanicsBenefit") {
      const distinctValues = new Set(observedValues.map(normalizeText).filter(Boolean));
      if (distinctValues.size !== competitors.length) {
        findings.push("The mechanics and player-benefit field does not give every competitor a distinct proposition.");
      }
    }
    if (fieldId === "fitTradeoff") {
      for (const [index, value] of observedValues.entries()) {
        if (value && (!/\bfit\b/iu.test(value) || !/trade[ -]?off/iu.test(value))) {
          findings.push(`${competitors[index]} fitTradeoff must state both a conditional fit and a major trade-off.`);
        }
      }
    }
  }

  const recommendationText = slides
    .flatMap((slide) => (Array.isArray(slide.bullets) ? slide.bullets : []))
    .filter(isRecord)
    .filter((bullet) => readText(bullet.claimKind).toLowerCase() === "recommendation")
    .map((bullet) => readText(bullet.text))
    .join(" ");
  if (intent.comparison && !/recommendation|best\s+for|consider|choose/iu.test(recommendationText)) {
    findings.push("The deck does not translate comparison evidence into conditional best-fit recommendations.");
  }
  if (!slides.some((slide) => readText(slide.archetype).toLowerCase() === "chart" && isRecord(slide.chart))) {
    findings.push("The deck lacks an additional analytical visual beyond the comparison matrices.");
  }
  if (
    !slides.some(
      (slide) =>
        /digital/iu.test(readText(slide.title)) && /adjacent|substitute|digital/iu.test(collectSlideText(slide)),
    )
  ) {
    findings.push("The deck does not keep digital clients and substitutes in a separate adjacent category.");
  }

  return {
    schemaVersion: 1,
    passed: findings.length === 0,
    findings,
    promptIntent: intent,
    metrics: {
      competitors: competitors.length,
      matrixCount: matrixModels.length,
      coveredMatrixFields: fieldLocations.size,
      canonicalSourceCount: canonicalSourceUrls.size,
      sourceDomainCount: sourceDomains.size,
      authoritativeOfficialCoverage: REQUIRED_CORE_GAMES.filter((game) =>
        sources.some((source) => isAuthoritativeOfficialSource(source, game)),
      ).length,
      independentSourceCount: independentCount,
      analyticalVisualCount: slides.filter(
        (slide) => readText(slide.archetype).toLowerCase() === "chart" && isRecord(slide.chart),
      ).length,
    },
  };
}

function derivePromptIntent(prompt, findings) {
  const text = readText(prompt);
  const intent = {
    marketResearch: /market\s+research|research/iu.test(text),
    ccgMarket: /\bccgs?\b|collectible\s+card\s+games?|trading\s+card\s+games?/iu.test(text),
    uniqueness: /unique|differentiat/iu.test(text),
    comparison: /better\s+than|competition|compar/iu.test(text),
    powerPoint: /power\s?point|pptx|slide\s+deck/iu.test(text),
  };
  for (const [name, present] of Object.entries(intent)) {
    if (!present) findings.push(`The replay prompt no longer expresses required ${name} intent.`);
  }
  return intent;
}

function locateRequiredMatrixFields(matrices, findings) {
  const locations = new Map();
  for (const requirement of REQUIRED_MATRIX_FIELDS) {
    const candidates = [];
    for (const matrix of matrices) {
      for (let index = 1; index < matrix.headers.length; index += 1) {
        if (requirement.pattern.test(cellText(matrix.headers[index]))) candidates.push({ matrix, columnIndex: index });
        requirement.pattern.lastIndex = 0;
      }
    }
    if (candidates.length !== 1) {
      findings.push(
        `Comparison matrices must contain exactly one ${requirement.id} field; found ${candidates.length}.`,
      );
      continue;
    }
    locations.set(requirement.id, candidates[0]);
  }
  return locations;
}

function readMatrix(slide) {
  const table = isRecord(slide.table) ? slide.table : undefined;
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return undefined;
  if (readText(slide.archetype).toLowerCase() !== "matrix") return undefined;
  if (!/\bgame\b/iu.test(cellText(table.headers[0]))) return undefined;
  return {
    title: readText(slide.title) || "untitled matrix",
    headers: table.headers,
    rows: table.rows.filter(Array.isArray),
  };
}

function isAuthoritativeOfficialSource(source, expected) {
  if (readText(source.role).toLowerCase() !== "official") return false;
  const url = canonicalHttpsUrl(source.url);
  if (!url) return false;
  const domain = new URL(url).hostname.toLowerCase();
  return expected.officialDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

function aliasesForCompetitor(competitor) {
  return REQUIRED_CORE_GAMES.find((game) => matchesAliases(competitor, game.aliases))?.aliases ?? [competitor];
}

function matchesAliases(value, aliases) {
  const normalized = normalizeText(value);
  const compact = normalized.replace(/\s+/gu, "");
  return aliases.some((alias) => {
    const normalizedAlias = normalizeText(alias);
    const compactAlias = normalizedAlias.replace(/\s+/gu, "");
    return normalized === normalizedAlias || compact === compactAlias || normalized.includes(normalizedAlias);
  });
}

function collectSlideText(slide) {
  return [
    readText(slide.title),
    ...(Array.isArray(slide.bullets)
      ? slide.bullets.map((bullet) => (isRecord(bullet) ? readText(bullet.text) : readText(bullet)))
      : []),
  ].join(" ");
}

function cellText(cell) {
  return isRecord(cell) ? readText(cell.text) : readText(cell);
}

function cellSourceIds(cell) {
  return isRecord(cell) && Array.isArray(cell.sourceIds) ? cell.sourceIds.map(readText).filter(Boolean) : [];
}

function canonicalHttpsUrl(value) {
  try {
    const parsed = new URL(readText(value));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    parsed.hash = "";
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return readText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
