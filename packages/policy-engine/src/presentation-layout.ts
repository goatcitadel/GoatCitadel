import type { ArtifactDesignPlan } from "./artifact-design.js";
import { presentationBulletText, type PresentationArchetype, type PresentationBullet } from "./presentation-model.js";

export interface PresentationSlideContent {
  title: string;
  bullets: PresentationBullet[];
  archetype?: PresentationArchetype;
  table?: unknown;
  chart?: unknown;
  generatedSourceAppendix?: boolean;
}

export type ContentSlideRenderer =
  | "image-text"
  | "two-column"
  | "stacked-list"
  | "stat-callout"
  | "comparison"
  | "table"
  | "table-continuation"
  | "chart"
  | "chart-continuation"
  | "section"
  | "section-continuation"
  | "sources"
  | "sources-continuation"
  | "closing";
export type PresentationDeckRenderer = "hero" | ContentSlideRenderer;
type SlideDensity = "empty" | "sparse" | "balanced" | "dense";

export interface PresentationSlideLayoutDecision {
  slideIndex: number;
  renderer: PresentationDeckRenderer;
  density: SlideDensity;
  bulletCount: number;
  reason: string;
}

export interface PresentationDeckQualitySummary {
  slideCount: number;
  contentSlideCount: number;
  emptyContentSlideCount: number;
  sparseContentSlideCount: number;
  denseContentSlideCount: number;
  weakContentSlideCount: number;
  dominantRenderer?: ContentSlideRenderer;
  dominantRendererCount: number;
  rendererCounts: Record<ContentSlideRenderer, number>;
  templateWarnings: string[];
  contentWarnings: string[];
  warnings: string[];
}

export function resolvePresentationDeckLayoutPlan(
  design: ArtifactDesignPlan,
  slides: PresentationSlideContent[],
  mappedVisualSlideIndexes: ReadonlySet<number> = new Set<number>(),
): PresentationSlideLayoutDecision[] {
  const decisions: PresentationSlideLayoutDecision[] = slides.map((slide, index) => {
    const density = classifySlideDensity(slide.bullets, Boolean(slide.table || slide.chart));
    if (index === 0) {
      return {
        slideIndex: index,
        renderer: "hero",
        density,
        bulletCount: slide.bullets.length,
        reason: "Title slide uses the deck hero template.",
      };
    }
    const semanticRenderer = resolveSemanticRenderer(slide);
    if (semanticRenderer) {
      return {
        slideIndex: index,
        renderer: semanticRenderer,
        density,
        bulletCount: slide.bullets.length,
        reason: `The ${slide.archetype ?? semanticRenderer} archetype uses its semantic renderer.`,
      };
    }
    if (mappedVisualSlideIndexes.has(index)) {
      return {
        slideIndex: index,
        renderer: "image-text",
        density,
        bulletCount: slide.bullets.length,
        reason: "An approved section visual takes precedence and is composed with the complete slide content.",
      };
    }
    const renderer = resolveContentSlideRenderer(design, index, slide);
    return {
      slideIndex: index,
      renderer,
      density,
      bulletCount: slide.bullets.length,
      reason: describeRendererChoice(renderer, density, design.layouts[index % design.layouts.length]?.name),
    };
  });
  return enforceAnalyticalLayoutRhythm(decisions, slides);
}

export function analyzePresentationDeckQuality(
  design: ArtifactDesignPlan,
  deckSlides: PresentationSlideContent[],
  mappedVisualSlideIndexes: ReadonlySet<number> = new Set<number>(),
): PresentationDeckQualitySummary {
  const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides, mappedVisualSlideIndexes);
  const contentSlides = deckSlides.slice(1);
  const analyticalContentSlides = contentSlides.filter((slide) => !slide.generatedSourceAppendix);
  const rendererCounts: Record<ContentSlideRenderer, number> = {
    "image-text": 0,
    "two-column": 0,
    "stacked-list": 0,
    "stat-callout": 0,
    comparison: 0,
    table: 0,
    "table-continuation": 0,
    chart: 0,
    "chart-continuation": 0,
    section: 0,
    "section-continuation": 0,
    sources: 0,
    "sources-continuation": 0,
    closing: 0,
  };
  layoutPlan.slice(1).forEach((decision, index) => {
    if (contentSlides[index]?.generatedSourceAppendix) return;
    if (decision.renderer !== "hero") {
      rendererCounts[decision.renderer] += 1;
    }
  });
  const densities = contentSlides.map((slide) =>
    classifySlideDensity(slide.bullets, Boolean(slide.table || slide.chart)),
  );
  const weakContentSlideCount = contentSlides.filter((slide) => hasWeakSlideContent(slide)).length;
  const rendererFamilyCounts = new Map<string, number>();
  layoutPlan.slice(1).forEach((decision, index) => {
    if (contentSlides[index]?.generatedSourceAppendix) return;
    const family = analyticalLayoutFamily(decision.renderer);
    rendererFamilyCounts.set(family, (rendererFamilyCounts.get(family) ?? 0) + 1);
  });
  const dominantFamilyEntry = [...rendererFamilyCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  const dominantRenderer = layoutPlan
    .slice(1)
    .find((decision) => analyticalLayoutFamily(decision.renderer) === dominantFamilyEntry?.[0])?.renderer as
    | ContentSlideRenderer
    | undefined;
  const dominantRendererCount = dominantFamilyEntry?.[1] ?? 0;
  const templateWarnings: string[] = [];
  const contentWarnings: string[] = [];
  const emptyContentSlideCount = densities.filter((density) => density === "empty").length;
  const denseContentSlideCount = densities.filter((density) => density === "dense").length;
  if (contentSlides.length === 0) {
    contentWarnings.push("No content slides were supplied beyond the title slide.");
  }
  if (emptyContentSlideCount > 0) {
    contentWarnings.push(`${emptyContentSlideCount} content slide(s) had no supporting bullets.`);
  }
  if (denseContentSlideCount > 0) {
    contentWarnings.push(
      `${denseContentSlideCount} content slide(s) had high text density and may need manual editing.`,
    );
  }
  if (contentSlides.length >= 3 && weakContentSlideCount / contentSlides.length >= 0.5) {
    contentWarnings.push(
      `${weakContentSlideCount} content slide(s) used very brief bullets; expand the story or add concrete examples before treating the deck as polished.`,
    );
  }
  const usedRendererCount = rendererFamilyCounts.size;
  const longestRepeatedRun = longestRendererRun(layoutPlan.slice(1), contentSlides);
  if (analyticalContentSlides.length >= 8 && usedRendererCount < 3) {
    templateWarnings.push(
      `Layout variety is low: ${usedRendererCount} layout families were used across ${analyticalContentSlides.length} analytical slides; at least 3 are expected.`,
    );
  }
  if (longestRepeatedRun > 2) {
    templateWarnings.push(
      `Layout repetition is high: one layout family repeats ${longestRepeatedRun} times consecutively.`,
    );
  }
  if (
    analyticalContentSlides.length >= 8 &&
    dominantRenderer &&
    dominantRendererCount / analyticalContentSlides.length > 0.6
  ) {
    templateWarnings.push(
      `Layout variety is low: ${dominantRendererCount} of ${analyticalContentSlides.length} analytical slide(s) use ${dominantRenderer}.`,
    );
  }
  const warnings = [...templateWarnings, ...contentWarnings];
  return {
    slideCount: deckSlides.length,
    contentSlideCount: contentSlides.length,
    emptyContentSlideCount,
    sparseContentSlideCount: densities.filter((density) => density === "sparse").length,
    denseContentSlideCount,
    weakContentSlideCount,
    dominantRenderer,
    dominantRendererCount,
    rendererCounts,
    templateWarnings,
    contentWarnings,
    warnings,
  };
}

export function resolveContentSlideRenderer(
  design: ArtifactDesignPlan,
  index: number,
  content: Pick<PresentationSlideContent, "title" | "bullets" | "archetype" | "table" | "chart">,
): ContentSlideRenderer {
  const semanticRenderer = resolveSemanticRenderer(content);
  if (semanticRenderer) {
    return semanticRenderer;
  }
  const bulletCount = content.bullets.length;
  const layout = design.layouts[index % design.layouts.length]?.name ?? "title-body";
  if (shouldUseTwoColumn(content.bullets, layout)) {
    // Dense decks should not collapse into the same split-card template on
    // every slide. Alternating with a full-width stacked treatment preserves
    // readable line length while giving the deck a visible rhythm.
    return index % 2 === 0 ? "stacked-list" : "two-column";
  }
  if (bulletCount > 0 && shouldUseCallout(content, layout)) {
    return "stat-callout";
  }
  return "image-text";
}

function classifySlideDensity(bullets: PresentationBullet[], hasSemanticData = false): SlideDensity {
  const textWeight = measureBulletTextWeight(bullets);
  if (bullets.length === 0) {
    return hasSemanticData ? "balanced" : "empty";
  }
  if (bullets.length <= 2) {
    return "sparse";
  }
  if (bullets.length <= 6 && textWeight < 360) {
    return "balanced";
  }
  return "dense";
}

function shouldUseTwoColumn(bullets: PresentationBullet[], layout: string): boolean {
  const textWeight = measureBulletTextWeight(bullets);
  if (bullets.length >= 6 || textWeight >= 260) {
    return true;
  }
  return layout === "two-column" && bullets.length >= 4 && textWeight >= 140;
}

function shouldUseCallout(content: Pick<PresentationSlideContent, "title" | "bullets">, layout: string): boolean {
  const firstBullet = content.bullets[0] ? presentationBulletText(content.bullets[0]) : "";
  if (content.bullets.length > 3) {
    return false;
  }
  const combined = `${content.title} ${firstBullet}`.toLowerCase();
  const calloutTerm = /\b(benefits?|impact|metrics?|results?|takeaway|key|priority|findings?|risks?|change)\b/u.test(
    combined,
  );
  const conciseBenefitSlide =
    content.bullets.length === 3 && /\b(benefits?|impact|metrics?|results?|findings?|risks?)\b/u.test(combined);
  return (
    firstBullet.length <= 140 &&
    content.bullets.every((bullet) => presentationBulletText(bullet).length <= 140) &&
    measureBulletTextWeight(content.bullets) <= 320 &&
    (layout === "stat-callout" || content.bullets.length <= 2 || conciseBenefitSlide || calloutTerm)
  );
}

function measureBulletTextWeight(bullets: PresentationBullet[]): number {
  return bullets.reduce((total, bullet) => total + presentationBulletText(bullet).trim().length, 0);
}

function hasWeakSlideContent(slide: PresentationSlideContent): boolean {
  if (slide.table || slide.chart) {
    return false;
  }
  const nonEmptyBullets = slide.bullets.map((bullet) => presentationBulletText(bullet).trim()).filter(Boolean);
  if (nonEmptyBullets.length === 0) {
    return false;
  }
  if (nonEmptyBullets.length === 1) {
    const onlyBullet = nonEmptyBullets[0] ?? "";
    return onlyBullet.length < 40 || countWords(onlyBullet) < 5;
  }
  const totalWords = nonEmptyBullets.reduce((total, bullet) => total + countWords(bullet), 0);
  const averageWords = totalWords / nonEmptyBullets.length;
  return averageWords < 5 && measureBulletTextWeight(nonEmptyBullets) < 130;
}

function resolveSemanticRenderer(
  content: Pick<PresentationSlideContent, "archetype" | "table" | "chart">,
): ContentSlideRenderer | undefined {
  if (content.table || content.archetype === "matrix") {
    return "table";
  }
  if (content.chart || content.archetype === "chart") {
    return "chart";
  }
  switch (content.archetype) {
    case "comparison":
      return "comparison";
    case "section":
      return "section";
    case "sources":
      return "sources";
    case "closing":
      return "closing";
    default:
      return undefined;
  }
}

function longestRendererRun(
  decisions: readonly PresentationSlideLayoutDecision[],
  slides: readonly PresentationSlideContent[],
): number {
  let longest = 0;
  let current = 0;
  let previous: PresentationDeckRenderer | undefined;
  decisions.forEach((decision, index) => {
    if (slides[index]?.generatedSourceAppendix) {
      current = 0;
      previous = undefined;
      return;
    }
    const renderer = decision.renderer;
    current = renderer === previous ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = renderer;
  });
  return longest;
}

function enforceAnalyticalLayoutRhythm(
  decisions: PresentationSlideLayoutDecision[],
  slides: readonly PresentationSlideContent[],
): PresentationSlideLayoutDecision[] {
  const result = decisions.map((decision) => ({ ...decision }));
  let previous: PresentationDeckRenderer | undefined;
  let repeated = 0;
  for (let index = 1; index < result.length; index += 1) {
    const current = result[index];
    const slide = slides[index];
    if (!current || current.renderer === "hero" || slide?.generatedSourceAppendix) {
      previous = undefined;
      repeated = 0;
      continue;
    }
    repeated = current.renderer === previous ? repeated + 1 : 1;
    if (repeated > 2) {
      current.renderer = continuationRenderer(current.renderer);
      current.reason = `${current.reason} Layout rhythm selected ${current.renderer} to avoid a third identical analytical layout.`;
      repeated = 1;
    }
    previous = current.renderer;
  }
  return result;
}

function continuationRenderer(renderer: ContentSlideRenderer): ContentSlideRenderer {
  switch (renderer) {
    case "table":
      return "table-continuation";
    case "chart":
      return "chart-continuation";
    case "section":
      return "section-continuation";
    case "sources":
      return "sources-continuation";
    case "comparison":
    case "two-column":
      return "stacked-list";
    case "stacked-list":
    case "image-text":
      return "two-column";
    case "stat-callout":
    case "closing":
      return "image-text";
    case "table-continuation":
      return "table";
    case "chart-continuation":
      return "chart";
    case "section-continuation":
      return "section";
    case "sources-continuation":
      return "sources";
  }
}

function analyticalLayoutFamily(renderer: PresentationDeckRenderer): string {
  switch (renderer) {
    case "comparison":
    case "two-column":
      return "columns";
    case "image-text":
    case "stacked-list":
      return "narrative";
    case "stat-callout":
    case "closing":
      return "callout";
    case "table-continuation":
      return "table";
    case "chart-continuation":
      return "chart";
    case "section-continuation":
      return "section";
    case "sources-continuation":
      return "sources";
    default:
      return renderer;
  }
}

function countWords(value: string): number {
  return value.split(/\s+/u).filter(Boolean).length;
}

function describeRendererChoice(
  renderer: ContentSlideRenderer,
  density: SlideDensity,
  requestedLayout?: string,
): string {
  if (renderer === "two-column") {
    return "High-density slide content uses two balanced columns to prevent text overflow.";
  }
  if (renderer === "stacked-list") {
    return "High-density slide content uses full-width stacked rows to vary the deck while preserving readable line length.";
  }
  if (renderer === "stat-callout") {
    return "Concise takeaway content uses a callout layout for stronger hierarchy.";
  }
  if (requestedLayout === "two-column" && density !== "dense") {
    return "Sparse or balanced content stays in the image-text template instead of forcing empty columns.";
  }
  return "Slide content uses the image-text template for a single readable idea with visual support.";
}
