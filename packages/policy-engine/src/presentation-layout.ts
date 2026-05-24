import type { ArtifactDesignPlan } from "./artifact-design.js";

export interface PresentationSlideContent {
  title: string;
  bullets: string[];
}

export type ContentSlideRenderer = "image-text" | "two-column" | "stat-callout";
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
): PresentationSlideLayoutDecision[] {
  return slides.map((slide, index) => {
    const density = classifySlideDensity(slide.bullets);
    if (index === 0) {
      return {
        slideIndex: index,
        renderer: "hero",
        density,
        bulletCount: slide.bullets.length,
        reason: "Title slide uses the deck hero template.",
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
}

export function analyzePresentationDeckQuality(
  design: ArtifactDesignPlan,
  deckSlides: PresentationSlideContent[],
): PresentationDeckQualitySummary {
  const layoutPlan = resolvePresentationDeckLayoutPlan(design, deckSlides);
  const contentSlides = deckSlides.slice(1);
  const rendererCounts: Record<ContentSlideRenderer, number> = {
    "image-text": 0,
    "two-column": 0,
    "stat-callout": 0,
  };
  layoutPlan.slice(1).forEach((decision) => {
    if (decision.renderer !== "hero") {
      rendererCounts[decision.renderer] += 1;
    }
  });
  const densities = contentSlides.map((slide) => classifySlideDensity(slide.bullets));
  const weakContentSlideCount = contentSlides.filter((slide) => hasWeakSlideContent(slide)).length;
  const dominantRendererEntry = Object.entries(rendererCounts).sort((left, right) => right[1] - left[1])[0] as
    | [ContentSlideRenderer, number]
    | undefined;
  const dominantRenderer = dominantRendererEntry?.[0];
  const dominantRendererCount = dominantRendererEntry?.[1] ?? 0;
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
  if (contentSlides.length >= 4 && dominantRenderer && dominantRendererCount / contentSlides.length >= 0.8) {
    templateWarnings.push(
      `Layout variety is low: ${dominantRendererCount} of ${contentSlides.length} content slide(s) use ${dominantRenderer}.`,
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
  content: Pick<PresentationSlideContent, "title" | "bullets">,
): ContentSlideRenderer {
  const bulletCount = content.bullets.length;
  const layout = design.layouts[index % design.layouts.length]?.name ?? "title-body";
  if (shouldUseTwoColumn(content.bullets, layout)) {
    return "two-column";
  }
  if (bulletCount > 0 && shouldUseCallout(content, layout)) {
    return "stat-callout";
  }
  return "image-text";
}

function classifySlideDensity(bullets: string[]): SlideDensity {
  const textWeight = measureBulletTextWeight(bullets);
  if (bullets.length === 0) {
    return "empty";
  }
  if (bullets.length <= 2) {
    return "sparse";
  }
  if (bullets.length <= 6 && textWeight < 360) {
    return "balanced";
  }
  return "dense";
}

function shouldUseTwoColumn(bullets: string[], layout: string): boolean {
  const textWeight = measureBulletTextWeight(bullets);
  if (bullets.length >= 6 || textWeight >= 260) {
    return true;
  }
  return layout === "two-column" && bullets.length >= 4 && textWeight >= 140;
}

function shouldUseCallout(content: Pick<PresentationSlideContent, "title" | "bullets">, layout: string): boolean {
  const firstBullet = content.bullets[0] ?? "";
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
    (layout === "stat-callout" || content.bullets.length <= 2 || conciseBenefitSlide || calloutTerm)
  );
}

function measureBulletTextWeight(bullets: string[]): number {
  return bullets.reduce((total, bullet) => total + bullet.trim().length, 0);
}

function hasWeakSlideContent(slide: PresentationSlideContent): boolean {
  const nonEmptyBullets = slide.bullets.map((bullet) => bullet.trim()).filter(Boolean);
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
  if (renderer === "stat-callout") {
    return "Concise takeaway content uses a callout layout for stronger hierarchy.";
  }
  if (requestedLayout === "two-column" && density !== "dense") {
    return "Sparse or balanced content stays in the image-text template instead of forcing empty columns.";
  }
  return "Slide content uses the image-text template for a single readable idea with visual support.";
}
