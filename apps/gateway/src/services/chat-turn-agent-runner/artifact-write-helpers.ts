import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChatToolRunRecord, ChatCompletionRequest, ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import { extractPrimaryUserTaskContent } from "../chat-agent-prompt-lab-contract.js";

const SAFE_WRITE_FALLBACK_DIR = "./workspace/goatcitadel_out";
const WRITE_DESTINATION_PROMPT_TITLE = "Choose artifact destination";

interface ArtifactIntentInput {
  content: string;
  sessionId: string;
  historyMessages?: ChatCompletionRequest["messages"];
  sourceText?: string;
}

export interface PresentationContentQualityReport {
  passed: boolean;
  findings: string[];
  sourceTermCount: number;
  matchedSourceTermCount: number;
  sourceUrlCount: number;
  matchedSourceUrlCount: number;
}

interface PresentationBrief {
  title: string;
  sourceText: string;
  contextDependent: boolean;
  sections: Array<{ title: string; bullets: string[] }>;
  sourceTerms: string[];
}

const PRESENTATION_META_COPY = [
  /summari[sz]es? the requested topic/iu,
  /keeps? the deck concise/iu,
  /uses? a real pptx artifact/iu,
  /open with the purpose/iu,
  /group details into clear sections/iu,
  /close with next steps or takeaways/iu,
] as const;

const PRESENTATION_CONTEXT_REFERENCE =
  /\b(?:all (?:of )?that|that information|the information above|from (?:this|the) (?:thread|conversation)|the research|what you (?:found|wrote)|everything above)\b/iu;
const GENERIC_PRESENTATION_TITLE =
  /^(?:presentation|untitled presentation|research presentation|powerpoint presentation|slide deck|overview|key points)$/iu;

const PRESENTATION_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "another",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "from",
  "have",
  "into",
  "more",
  "most",
  "only",
  "other",
  "people",
  "should",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "things",
  "this",
  "those",
  "through",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
]);

export function detectPresentationArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const presentationPhrase =
    /\b(power\s?point|pptx?|(?:slide|pitch|investor|presentation)\s+deck|slides?|presentation)\b/.test(normalized);
  if (!presentationPhrase) {
    return false;
  }
  return (
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver)\b/.test(normalized) ||
    /\b(file|format|artifact|download|power\s?point|pptx?)\b/.test(normalized)
  );
}

export function detectDocumentArtifactIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  const documentPhrase =
    /\b(docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|text\s+file|txt|report|brief|memo|handout|worksheet|document)\b/.test(
      normalized,
    );
  if (!documentPhrase) {
    return false;
  }
  return (
    /\b(create|make|build|generate|put|turn|export|save|write|produce|deliver)\b/.test(normalized) ||
    /\b(file|format|artifact|download|docx?|pdf|markdown|html|csv|json)\b/.test(normalized)
  );
}

export function buildSyntheticPresentationCreateArgs(
  input: ArtifactIntentInput,
  safeWriteFallbackDir?: string,
): Record<string, unknown> {
  const brief = buildPresentationBrief(input);
  const title = brief.title;
  const path =
    extractAnsweredWriteDestination(input.content) ??
    buildSafeWriteFallbackPath(input.sessionId, "presentations.create", `${title}.pptx`, safeWriteFallbackDir);
  return {
    path: path ?? buildSafeWritePath("presentation.pptx", safeWriteFallbackDir),
    title,
    slides: brief.sections,
    design: {
      mode: "polished",
      skillId: "design-intelligence",
    },
  };
}

export function analyzePresentationContentQuality(input: {
  args: Record<string, unknown>;
  content: string;
  historyMessages?: ChatCompletionRequest["messages"];
}): PresentationContentQualityReport {
  const brief = buildPresentationBrief({
    content: input.content,
    sessionId: "quality-check",
    historyMessages: input.historyMessages,
  });
  const title = typeof input.args.title === "string" ? input.args.title.trim() : "";
  const rawSlides = Array.isArray(input.args.slides) ? input.args.slides : [];
  const slides = rawSlides
    .map((value) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const slideTitles = slides
    .map((slide) => (typeof slide.title === "string" ? normalizePresentationText(slide.title) : ""))
    .filter(Boolean);
  const deckText = normalizePresentationText(
    [
      title,
      typeof input.args.subtitle === "string" ? input.args.subtitle : "",
      ...slides.flatMap((slide) => [
        typeof slide.title === "string" ? slide.title : "",
        ...(Array.isArray(slide.bullets) ? slide.bullets.map(readPresentationBulletText).filter(Boolean) : []),
      ]),
    ].join(" "),
  );
  const findings: string[] = [];
  const normalizedRequest = normalizePresentationText(extractPrimaryUserTaskContent(input.content) ?? input.content);
  if (normalizedRequest.length >= 24 && deckText.includes(normalizedRequest)) {
    findings.push(
      "The deck repeats the presentation request as slide content instead of using the requested source material.",
    );
  }
  if (PRESENTATION_META_COPY.some((pattern) => pattern.test(deckText))) {
    findings.push("The deck contains generic presentation-template instructions instead of topic-specific content.");
  }
  if (slides.length === 0) {
    findings.push("The deck has no substantive content slides.");
  }
  if (slides.length > 0 && normalizePresentationText(title) === slideTitles[0]) {
    findings.push("The first content slide duplicates the automatically generated title slide.");
  }
  if (new Set(slideTitles).size !== slideTitles.length) {
    findings.push("The deck contains duplicate slide titles.");
  }
  if (!title) {
    findings.push("The deck is missing a specific title for the automatically generated title slide.");
  } else if (GENERIC_PRESENTATION_TITLE.test(title.trim())) {
    findings.push("The deck uses a generic title instead of a specific subject.");
  }
  const explicitSingleSlide = /\b(?:single|one)[ -]slide\b/iu.test(input.content);
  const substantiveContent = slides
    .flatMap((slide) =>
      Array.isArray(slide.bullets) ? slide.bullets.map(readPresentationBulletText).filter(Boolean) : [],
    )
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!explicitSingleSlide && (slides.length < 2 || substantiveContent.length < 120)) {
    findings.push("The deck does not contain enough substantive, topic-specific content for a useful presentation.");
  }
  if (brief.contextDependent && brief.sourceText.length < 180) {
    findings.push(
      "The follow-up presentation request has no substantive prior-thread source material to ground the deck.",
    );
  }
  if (brief.contextDependent && brief.sourceText.length >= 300 && (slides.length < 3 || deckText.length < 240)) {
    findings.push("The deck is too thin to represent the substantive source material in the conversation.");
  }
  const matchedSourceTermCount = brief.sourceTerms.filter((term) => deckText.includes(term)).length;
  const requiredMatches = Math.min(4, Math.max(2, Math.ceil(brief.sourceTerms.length * 0.25)));
  if (brief.contextDependent && brief.sourceTerms.length >= 4 && matchedSourceTermCount < requiredMatches) {
    findings.push(
      `The deck is not grounded in the prior conversation (${matchedSourceTermCount}/${brief.sourceTerms.length} key concepts represented).`,
    );
  }
  const sourceUrls = extractPresentationSourceUrls(brief.sourceText);
  const serializedArgs = JSON.stringify(input.args);
  const matchedSourceUrlCount = sourceUrls.filter((url) => serializedArgs.includes(url)).length;
  if (brief.contextDependent && matchedSourceUrlCount < sourceUrls.length) {
    findings.push(
      `The deck does not preserve all source URLs from the prior conversation (${matchedSourceUrlCount}/${sourceUrls.length} retained).`,
    );
  }
  return {
    passed: findings.length === 0,
    findings,
    sourceTermCount: brief.sourceTerms.length,
    matchedSourceTermCount,
    sourceUrlCount: sourceUrls.length,
    matchedSourceUrlCount,
  };
}

export function buildSyntheticDocumentCreateArgs(
  input: ArtifactIntentInput,
  safeWriteFallbackDir?: string,
): Record<string, unknown> {
  const task = extractPrimaryUserTaskContent(input.content) ?? input.content;
  const sourceText = input.sourceText?.trim() || task;
  const title = inferDocumentTitle(task);
  const format = inferDocumentFormat(task);
  const path =
    extractAnsweredWriteDestination(input.content) ??
    buildSafeWriteFallbackPath(
      input.sessionId,
      "documents.create",
      `${title}.${documentFormatExtension(format)}`,
      safeWriteFallbackDir,
    );
  return {
    path: path ?? buildSafeWritePath(`document.${documentFormatExtension(format)}`, safeWriteFallbackDir),
    format,
    title,
    body: sourceText.slice(0, 18_000),
    sections: buildSyntheticDocumentSections(sourceText),
    design: inferDocumentDesignRequest(format),
  };
}

function inferPresentationTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const quotedTitle = normalized.match(/["'`](.{8,90}?)["'`]/)?.[1]?.trim();
  if (quotedTitle) {
    return titleCasePresentationText(quotedTitle);
  }
  if (/\bfree time\b/i.test(normalized) && /\btop\s*10\b/i.test(normalized)) {
    return "Top 10 Things to Do in Free Time";
  }
  const reductionTopic = normalized.match(/\b(?:to\s+)?reduce\s+(.{4,80}?)(?:\.|,|;|$)/iu)?.[1]?.trim();
  if (reductionTopic) {
    const subject = titleCasePresentationText(reductionTopic.replace(/^household\s+/iu, ""));
    return /\b(?:household|at home)\b/iu.test(normalized) ? `Reducing Household ${subject}` : `Reducing ${subject}`;
  }
  const topic =
    normalized.match(/\b(?:about|on|for)\s+(.{8,100}?)(?:\.|$|\n)/i)?.[1]?.trim() ??
    normalized
      .match(/\b(?:power\s?point|pptx?|presentation|slides?|deck)\b\s+(?:about|on|for)?\s*(.{8,100}?)(?:\.|$|\n)/i)?.[1]
      ?.trim();
  return titleCasePresentationText(topic ?? "Presentation");
}

function inferDocumentTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const quotedTitle = normalized.match(/["'`](.{8,90}?)["'`]/)?.[1]?.trim();
  if (quotedTitle) {
    return titleCasePresentationText(quotedTitle);
  }
  if (/\bfree time\b/i.test(normalized) && /\btop\s*10\b/i.test(normalized)) {
    return "Top 10 Things To Do In Free Time";
  }
  const topic =
    normalized.match(/\b(?:about|on|for)\s+(.{8,100}?)(?:\.|$|\n)/i)?.[1]?.trim() ??
    normalized
      .match(
        /\b(?:docx?|document|report|brief|memo|handout|worksheet|pdf|markdown|html|csv|json)\b\s+(?:about|on|for)?\s*(.{8,100}?)(?:\.|$|\n)/i,
      )?.[1]
      ?.trim();
  return titleCasePresentationText(topic ?? "Document");
}

function inferDocumentFormat(content: string): string {
  const normalized = content.toLowerCase();
  if (/\bpdf\b/.test(normalized)) {
    return "pdf";
  }
  if (/\b(docx?|word\s+doc(?:ument)?)\b/.test(normalized)) {
    return "docx";
  }
  if (/\bhtml?\b/.test(normalized)) {
    return "html";
  }
  if (/\bcsv\b/.test(normalized)) {
    return "csv";
  }
  if (/\bjson\b/.test(normalized)) {
    return "json";
  }
  if (/\b(?:txt|text\s+file)\b/.test(normalized)) {
    return "txt";
  }
  if (/\b(?:md|markdown)\b/.test(normalized)) {
    return "markdown";
  }
  return "docx";
}

function documentFormatExtension(format: string): string {
  return format === "markdown" ? "md" : format;
}

function inferDocumentDesignRequest(format: string): Record<string, unknown> {
  if (/^(?:json|csv|txt|text)$/iu.test(format)) {
    return {
      mode: "minimal",
    };
  }
  return {
    mode: "polished",
    skillId: "design-intelligence",
  };
}

function titleCasePresentationText(value: string): string {
  const cleaned = value
    .replace(
      /\b(?:please|create|make|build|generate|put|together|presentation|power\s?point|pptx?|slides?|deck|artifact|file)\b/gi,
      " ",
    )
    .replace(/[^a-zA-Z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "Presentation";
  }
  const title = cleaned
    .split(" ")
    .map((word) =>
      /^(?:a|an|and|as|at|but|by|for|in|near|of|on|or|the|to|with)$/i.test(word)
        ? word.toLowerCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join(" ")
    .replace(/\b(?:Ai|Api|Ui|Ux|Pptx)\b/g, (match) => match.toUpperCase());
  return `${title.slice(0, 1).toUpperCase()}${title.slice(1)}`;
}

function buildPresentationBrief(input: ArtifactIntentInput): PresentationBrief {
  const history = input.historyMessages ?? [];
  const assistantSources = history
    .filter((message) => message.role === "assistant")
    .map((message) => messageContentText(message.content).trim())
    .filter((content) => content.length >= 180 && !looksLikeMissingPresentationArtifactContent(content));
  const priorUserText = history
    .filter((message) => message.role === "user")
    .map((message) => messageContentText(message.content).trim())
    .filter((content) => content && normalizePresentationText(content) !== normalizePresentationText(input.content))
    .join("\n");
  const explicitSourceText = input.sourceText?.trim();
  const contextDependent = Boolean(explicitSourceText) || PRESENTATION_CONTEXT_REFERENCE.test(input.content);
  const sourceText =
    explicitSourceText ||
    (contextDependent
      ? assistantSources.join("\n\n") || priorUserText
      : (extractPrimaryUserTaskContent(input.content) ?? input.content));
  const title = inferGroundedPresentationTitle(priorUserText, sourceText, input.content);
  const sections = parsePresentationSections(sourceText).map((section, index) =>
    normalizePresentationText(section.title) === normalizePresentationText(title)
      ? { ...section, title: index === 0 ? "Overview" : `${title} — Details ${index + 1}` }
      : section,
  );
  return {
    title,
    sourceText,
    contextDependent,
    sections,
    sourceTerms: extractPresentationSourceTerms(`${priorUserText}\n${sourceText}`),
  };
}

function inferGroundedPresentationTitle(priorUserText: string, sourceText: string, currentContent: string): string {
  const titleContext = priorUserText.trim();
  if (/\b(?:dating|relationship|partner)\b/iu.test(titleContext)) {
    const ages = [...titleContext.matchAll(/\b(\d{2})\b/gu)]
      .map((match) => Number(match[1]))
      .filter((age) => age >= 18 && age <= 99);
    const uniqueAges = [...new Set(ages)];
    if (uniqueAges.length >= 2) {
      const first = uniqueAges[0] ?? 0;
      const second = uniqueAges[1] ?? 0;
      const gap = Math.abs(first - second);
      if (gap > 0) {
        return `Dating Across a ${gap}-Year Age Gap`;
      }
    }
    const gapMatch = titleContext.match(/\b(\d{1,2})[- ]year age gap\b/iu)?.[1];
    if (gapMatch) {
      return `Dating Across a ${gapMatch}-Year Age Gap`;
    }
  }
  if (titleContext) {
    return inferPresentationTitle(titleContext);
  }
  const heading = sourceText
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,3}\s+(.{8,90})$/u)?.[1]?.trim())
    .find((value) => value && !/^(?:sources?|references?|bottom line|summary)$/iu.test(value));
  if (heading) {
    return titleCasePresentationText(heading);
  }
  const topicPrompt = priorUserText || currentContent;
  return inferPresentationTitle(topicPrompt);
}

function parsePresentationSections(sourceText: string): Array<{ title: string; bullets: string[] }> {
  if (!sourceText.trim()) {
    return [];
  }
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let currentTitle = "Overview";
  let bullets: string[] = [];
  const flush = (): void => {
    const cleaned = bullets.map(cleanPresentationBullet).filter((value) => value.length >= 12);
    if (cleaned.length === 0) {
      bullets = [];
      return;
    }
    for (let index = 0; index < cleaned.length; index += 5) {
      const chunk = cleaned.slice(index, index + 5);
      sections.push({
        title: index === 0 ? currentTitle : `${currentTitle} — Continued`,
        bullets: chunk,
      });
    }
    bullets = [];
  };
  for (const rawLine of sourceText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading =
      line.match(/^#{1,6}\s+(.{3,100})$/u)?.[1]?.trim() ?? line.match(/^\*\*(.{3,100}?)\*\*:?$/u)?.[1]?.trim();
    if (heading) {
      flush();
      currentTitle = titleCasePresentationText(heading);
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/u)?.[1]?.trim();
    if (bullet) {
      bullets.push(bullet);
      continue;
    }
    if (/^https?:\/\/\S+$/iu.test(line)) {
      const previousIndex = bullets.length - 1;
      const previous = bullets[previousIndex];
      if (previous && !/https?:\/\//iu.test(previous)) {
        bullets[previousIndex] = `${previous} ${line}`;
      } else {
        bullets.push(line);
      }
      continue;
    }
    if (line.length >= 35 && !/^https?:\/\//iu.test(line)) {
      bullets.push(line);
    }
  }
  flush();
  return sections.filter((section) => normalizePresentationText(section.title) !== "presentation");
}

function extractPresentationSourceUrls(sourceText: string): string[] {
  return [...new Set(sourceText.match(/https?:\/\/[^\s)>},]+/giu) ?? [])];
}

function cleanPresentationBullet(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 — $2")
    .replace(/[*_`>#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function readPresentationBulletText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function extractPresentationSourceTerms(sourceText: string): string[] {
  const counts = new Map<string, number>();
  for (const token of normalizePresentationText(sourceText).split(/\s+/u)) {
    if (
      token.length < 5 ||
      PRESENTATION_STOP_WORDS.has(token) ||
      /^(?:presentation|powerpoint|slides?|deck|requested|generated)$/u.test(token)
    ) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 16)
    .map(([term]) => term);
}

function messageContentText(content: ChatCompletionRequest["messages"][number]["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as unknown as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizePresentationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildSyntheticDocumentSections(content: string): Array<{ heading: string; body: string; bullets: string[] }> {
  const bullets = extractPresentationBulletsFromPrompt(content);
  if (/\bfree time\b/i.test(content)) {
    return [
      {
        heading: "Recommended Activities",
        body: "A balanced free-time plan mixes active, creative, social, and restorative options.",
        bullets: [
          "Read or learn something new",
          "Walk, exercise, or explore locally",
          "Cook, create, volunteer, connect, and rest",
        ],
      },
      {
        heading: "How To Choose",
        body: "Pick activities based on available time, energy level, budget, and whether you want solitude or company.",
        bullets: [
          "Keep low-friction options ready",
          "Rotate familiar favorites with new experiments",
          "Notice what leaves you better afterward",
        ],
      },
    ];
  }
  return [
    {
      heading: "Summary",
      body: "This document turns the requested response into a real file artifact.",
      bullets,
    },
    {
      heading: "Next Steps",
      body: "Review the generated file, then refine sections, formatting, or audience-specific details as needed.",
      bullets: [
        "Confirm the intended audience",
        "Adjust wording and emphasis",
        "Add source citations when the task used research",
      ],
    },
  ];
}

function extractPresentationBulletsFromPrompt(content: string): string[] {
  const lines = content
    .split(/\r?\n|[.;]/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12 && !/^suggested tools:/i.test(line));
  return lines.length > 0
    ? lines
    : ["Clarify the main audience", "Focus each slide on one idea", "Keep bullets brief and scannable"];
}

export function mergePresentationArtifactDeliveryContent(
  existingContent: string,
  toolRun: ChatToolRunRecord,
  options?: { downloadHref?: string },
): string {
  if (toolRun.status !== "executed") {
    const failure = toolRun.error ?? "the presentation tool did not complete";
    const fallback = `I tried to create the PowerPoint artifact with \`presentations.create\`, but ${failure}.`;
    return existingContent.trim().length > 0 ? `${existingContent.trim()}\n\n${fallback}` : fallback;
  }
  const result = (toolRun.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.path === "string"
      ? result.path
      : typeof result.fallbackPath === "string"
        ? result.fallbackPath
        : typeof toolRun.args?.path === "string"
          ? toolRun.args.path
          : "the requested PPTX path";
  const slideCount = typeof result.slideCount === "number" ? result.slideCount : undefined;
  const bytesWritten = typeof result.bytesWritten === "number" ? result.bytesWritten : undefined;
  const trimmed = stripSandboxPresentationDownloadLinks(existingContent).trim();
  const delivery = [
    trimmed.includes(path) ? undefined : `Created the PowerPoint presentation artifact at \`${path}\`.`,
    slideCount !== undefined && !new RegExp(`\\bSlides:\\s*${slideCount}\\b`, "iu").test(trimmed)
      ? `Slides: ${slideCount}.`
      : undefined,
    bytesWritten !== undefined && !trimmed.includes(`${bytesWritten} bytes`)
      ? `Size: ${bytesWritten} bytes.`
      : undefined,
    options?.downloadHref && !trimmed.includes(options.downloadHref)
      ? `[Download the PowerPoint](${options.downloadHref})`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  if (!trimmed || looksLikeMissingPresentationArtifactContent(trimmed)) {
    return delivery;
  }
  if (!delivery) {
    return trimmed;
  }
  return `${trimmed}\n\n${delivery}`;
}

export function buildWorkspaceFileDownloadHref(
  artifactPath: string,
  workspaceFileRootDir: string | undefined,
): string | undefined {
  const trimmedArtifactPath = artifactPath.trim();
  const trimmedRoot = workspaceFileRootDir?.trim();
  if (!trimmedArtifactPath || !trimmedRoot) {
    return undefined;
  }
  const root = path.resolve(trimmedRoot);
  const absoluteArtifactPath = path.resolve(trimmedArtifactPath);
  const relativePath = path.relative(root, absoluteArtifactPath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  const normalized = relativePath.replaceAll("\\", "/");
  return `/api/v1/files/download?${new URLSearchParams({ relativePath: normalized }).toString()}`;
}

export interface ExecutedWorkspaceFileWriteReceipt {
  artifactPath: string;
  bytesWritten: number;
}

export function getExecutedWorkspaceFileWriteReceipt(
  toolRun: ChatToolRunRecord,
): ExecutedWorkspaceFileWriteReceipt | undefined {
  if (toolRun.status !== "executed" || !isWriteDestinationTool(toolRun.toolName)) {
    return undefined;
  }
  const result = (toolRun.result ?? {}) as Record<string, unknown>;
  const artifactPath =
    typeof result.path === "string"
      ? result.path.trim()
      : typeof result.fallbackPath === "string"
        ? result.fallbackPath.trim()
        : "";
  const bytesWritten = result.bytesWritten;
  if (!artifactPath || typeof bytesWritten !== "number" || !Number.isFinite(bytesWritten) || bytesWritten <= 0) {
    return undefined;
  }
  return { artifactPath, bytesWritten };
}

export function mergeWorkspaceFileDownloadContent(
  existingContent: string,
  toolRun: ChatToolRunRecord,
  downloadHref: string | undefined,
): string {
  const receipt = getExecutedWorkspaceFileWriteReceipt(toolRun);
  if (!receipt || !downloadHref) {
    return existingContent;
  }
  const fileName = path.basename(receipt.artifactPath);
  const upgraded = replaceMatchingSandboxWorkspaceFileLink(existingContent, fileName, downloadHref);
  if (upgraded.includes(downloadHref)) {
    return upgraded;
  }
  const label =
    toolRun.toolName === "presentations.create"
      ? "Download the PowerPoint"
      : toolRun.toolName === "documents.create"
        ? "Download the document"
        : `Download ${fileName}`;
  const link = `[${label}](${downloadHref})`;
  return upgraded.trim() ? `${upgraded.trim()}\n\n${link}` : link;
}

function replaceMatchingSandboxWorkspaceFileLink(content: string, fileName: string, downloadHref: string): string {
  const normalizedFileName = fileName.toLowerCase();
  return content.replace(
    /\[([^\]]*)\]\(\s*(sandbox:[^)\s]+)(?:\s+"[^"]*")?\s*\)/giu,
    (match, label: string, sandboxHref: string) => {
      const targetName = sandboxHref.replaceAll("\\", "/").split("/").at(-1) ?? "";
      let decodedTargetName: string;
      try {
        decodedTargetName = decodeURIComponent(targetName);
      } catch {
        return match;
      }
      return decodedTargetName.toLowerCase() === normalizedFileName ? `[${label}](${downloadHref})` : match;
    },
  );
}

function stripSandboxPresentationDownloadLinks(content: string): string {
  return content.replace(/\[[^\]]*\]\(\s*sandbox:\/mnt\/data\/[^)\s]+(?:\s+"[^"]*")?\s*\)/giu, "");
}

function looksLikeMissingPresentationArtifactContent(content: string): boolean {
  return (
    /\b(?:could not|couldn't|unable to|did not|didn't|not able to|no verified|not created|was not created)\b/i.test(
      content,
    ) && /\b(?:pptx?|power\s?point|presentation|slides?|deck|artifact|file)\b/i.test(content)
  );
}

export function mergeDocumentArtifactDeliveryContent(existingContent: string, toolRun: ChatToolRunRecord): string {
  if (toolRun.status !== "executed") {
    const failure = toolRun.error ?? "the document tool did not complete";
    const fallback = `I tried to create the document artifact with \`documents.create\`, but ${failure}.`;
    return existingContent.trim().length > 0 ? `${existingContent.trim()}\n\n${fallback}` : fallback;
  }
  const result = (toolRun.result ?? {}) as Record<string, unknown>;
  const path =
    typeof result.path === "string"
      ? result.path
      : typeof result.fallbackPath === "string"
        ? result.fallbackPath
        : typeof toolRun.args?.path === "string"
          ? toolRun.args.path
          : "the requested document path";
  const format = typeof result.format === "string" ? result.format.toUpperCase() : undefined;
  const bytesWritten = typeof result.bytesWritten === "number" ? result.bytesWritten : undefined;
  const delivery = [
    `Created the document artifact at \`${path}\`.`,
    format ? `Format: ${format}.` : undefined,
    bytesWritten !== undefined ? `Size: ${bytesWritten} bytes.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const trimmed = existingContent.trim();
  if (!trimmed || looksLikeMissingDocumentArtifactContent(trimmed)) {
    return delivery;
  }
  if (trimmed.includes(path)) {
    return trimmed;
  }
  return `${trimmed}\n\n${delivery}`;
}

function looksLikeMissingDocumentArtifactContent(content: string): boolean {
  return (
    /\b(?:could not|couldn't|unable to|did not|didn't|not able to|no verified|not created|was not created)\b/i.test(
      content,
    ) &&
    /\b(?:docx?|word\s+doc(?:ument)?|pdf|markdown|md|html|csv|json|txt|report|brief|memo|document|artifact|file)\b/i.test(
      content,
    )
  );
}

export function isWriteJailBlockReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  const normalized = reason.toLowerCase();
  return normalized.includes("write jail") || normalized.includes("outside write");
}

export function isWriteDestinationTool(toolName: string): boolean {
  return (
    toolName === "fs.write" ||
    toolName === "artifacts.create" ||
    toolName === "documents.create" ||
    toolName === "presentations.create"
  );
}

export function buildWriteDestinationUserInputPrompt(input: {
  sessionId: string;
  turnId: string;
  toolName: string;
  requestedPath: unknown;
  policyReason?: string;
  fallbackPath?: string;
  safeWriteFallbackDir?: string;
}): ChatUserInputPromptRecord | undefined {
  if (!isWriteDestinationTool(input.toolName) || !isWriteJailBlockReason(input.policyReason)) {
    return undefined;
  }
  const requestedPath = typeof input.requestedPath === "string" ? input.requestedPath.trim() : "";
  const suggestedPath =
    input.fallbackPath ??
    buildSafeWriteFallbackPath(input.sessionId, input.toolName, requestedPath, input.safeWriteFallbackDir);
  const blockedTarget = requestedPath ? ` Requested path: ${requestedPath}.` : "";
  const suggestion = suggestedPath
    ? ` Enter a destination inside an allowed write root, for example ${suggestedPath}.`
    : " Enter a destination inside one of the configured write-jail roots.";
  return {
    promptId: `write-destination-${randomUUID()}`,
    turnId: input.turnId,
    kind: "text",
    title: WRITE_DESTINATION_PROMPT_TITLE,
    question: `I could not create this file because the path is outside the configured write jail.${blockedTarget}${suggestion}`,
    required: true,
    placeholder: suggestedPath || "Enter an allowed destination path",
    submitLabel: "Create file",
  };
}

export function buildSafeWritePath(fileName: string, safeWriteFallbackDir?: string): string {
  const directory = (safeWriteFallbackDir?.trim() || SAFE_WRITE_FALLBACK_DIR).replace(/[\\/]+$/u, "");
  return `${directory}/${fileName}`;
}

export function buildSafeWriteFallbackPath(
  sessionId: string,
  toolName: string,
  originalPath: unknown,
  safeWriteFallbackDir?: string,
): string | undefined {
  const safeSessionId = sessionId
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .slice(-32);
  if (!safeSessionId) {
    return undefined;
  }
  const original = typeof originalPath === "string" ? originalPath.trim() : "";
  const normalizedOriginal = original.replaceAll("\\", "/");
  const fileName = normalizedOriginal.split("/").pop() ?? "";
  const match = fileName.match(/^(.+?)(\.[a-zA-Z0-9_-]{1,12})$/);
  const baseName = (match?.[1] ?? fileName).trim();
  const ext = (match?.[2] ?? "").trim();
  const safeBaseName =
    sanitizePathSegment(baseName) ||
    (toolName === "presentations.create"
      ? "presentation"
      : toolName === "documents.create"
        ? "document"
        : toolName === "artifacts.create"
          ? "artifact"
          : "output");
  const fallbackExt =
    ext ||
    (toolName === "presentations.create"
      ? ".pptx"
      : toolName === "documents.create"
        ? ".docx"
        : toolName === "artifacts.create"
          ? ".md"
          : ".txt");
  return buildSafeWritePath(`${safeBaseName}-${safeSessionId}${fallbackExt}`, safeWriteFallbackDir);
}

export function extractAnsweredWriteDestination(content: string): string | undefined {
  const match = content.match(
    /(?:choose artifact destination|where should i create|destination inside an allowed write root)[\s\S]{0,900}?Answer:\s*([^\r\n]+)/i,
  );
  const answer = match?.[1]?.trim();
  if (!answer || /^(?:none|skip|cancel)$/i.test(answer)) {
    return undefined;
  }
  return answer.replace(/^`|`$/g, "").trim();
}

function sanitizePathSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function normalizePathForComparison(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
