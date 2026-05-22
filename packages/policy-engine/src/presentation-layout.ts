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
  rendererCounts: Record<ContentSlideRenderer, number>;
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
  const emptyContentSlideCount = densities.filter((density) => density === "empty").length;
  const denseContentSlideCount = densities.filter((density) => density === "dense").length;
  const warnings: string[] = [];
  if (contentSlides.length === 0) {
    warnings.push("No content slides were supplied beyond the title slide.");
  }
  if (emptyContentSlideCount > 0) {
    warnings.push(`${emptyContentSlideCount} content slide(s) had no supporting bullets.`);
  }
  if (denseContentSlideCount > 0) {
    warnings.push(`${denseContentSlideCount} content slide(s) had high text density and may need manual editing.`);
  }
  return {
    slideCount: deckSlides.length,
    contentSlideCount: contentSlides.length,
    emptyContentSlideCount,
    sparseContentSlideCount: densities.filter((density) => density === "sparse").length,
    denseContentSlideCount,
    rendererCounts,
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
  if (content.bullets.length > 2) {
    return false;
  }
  const combined = `${content.title} ${firstBullet}`.toLowerCase();
  const calloutTerm = /\b(benefit|impact|metric|result|takeaway|key|why|priority|finding|risk|change)\b/u.test(
    combined,
  );
  return firstBullet.length <= 140 && (layout === "stat-callout" || content.bullets.length === 1 || calloutTerm);
}

function measureBulletTextWeight(bullets: string[]): number {
  return bullets.reduce((total, bullet) => total + bullet.trim().length, 0);
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
