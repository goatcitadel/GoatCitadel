export type ArtifactKind = "presentation" | "document" | "html" | "pdf" | "data";

export type ArtifactDesignMode = "auto" | "polished" | "minimal" | "plain";

export type ArtifactDesignPreset =
  | "auto"
  | "clean-professional"
  | "education"
  | "wellness"
  | "pitch"
  | "technical-report"
  | "cyberpunk-ops";

export type ArtifactVisualLevel = "minimal" | "polished" | "rich";

export type ArtifactAssetPolicy = "auto" | "generated-first" | "web-first" | "built-in-only" | "none";

export interface ArtifactBrandInput {
  name?: string;
  colors?: string[];
  fonts?: string[];
  logoPath?: string;
}

export interface ArtifactDesignRequest {
  mode?: ArtifactDesignMode;
  preset?: ArtifactDesignPreset;
  visualLevel?: ArtifactVisualLevel;
  assetPolicy?: ArtifactAssetPolicy;
  audience?: string;
  brand?: ArtifactBrandInput;
}

export interface ArtifactDestinationRequest {
  kind: "local" | "google-docs" | "google-slides" | "google-drive";
  folderId?: string;
  title?: string;
  convert?: boolean;
}

export interface ArtifactColorTokens {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  accent: string;
  accent2: string;
  accent3: string;
  border: string;
}

export interface ArtifactTypographyTokens {
  headingFont: string;
  bodyFont: string;
}

export interface ArtifactLayoutPlan {
  name: string;
  purpose: string;
}

export interface ArtifactAssetPlanItem {
  id: string;
  type: "generated" | "web" | "built_in" | "local";
  role: "hero" | "supporting" | "icon" | "chart" | "provenance";
  status: "planned" | "used" | "skipped";
  description: string;
  altText: string;
  source?: string;
  license?: string;
  reason?: string;
}

export interface ArtifactGuideReference {
  title: string;
  url: string;
  ruleSummary: string;
}

export interface ArtifactValidationCheck {
  id: string;
  label: string;
  status: "planned" | "passed" | "warning" | "skipped";
  detail: string;
}

export interface ArtifactGoogleImportStatus {
  requested: boolean;
  status: "not_requested" | "not_configured" | "import_ready" | "imported" | "failed";
  mode: "convert";
  url?: string;
  reason?: string;
}

export interface ArtifactDesignPlan {
  kind: ArtifactKind;
  mode: ArtifactDesignMode;
  preset: Exclude<ArtifactDesignPreset, "auto">;
  visualLevel: ArtifactVisualLevel;
  assetPolicy: ArtifactAssetPolicy;
  audience?: string;
  brand?: ArtifactBrandInput;
  tokens: ArtifactColorTokens;
  typography: ArtifactTypographyTokens;
  layouts: ArtifactLayoutPlan[];
  assetPlan: ArtifactAssetPlanItem[];
  validationChecks: ArtifactValidationCheck[];
  guideReferences: ArtifactGuideReference[];
  destination: ArtifactDestinationRequest;
  outputNotes: string[];
}

export interface ArtifactDesignReport {
  mode: ArtifactDesignMode;
  preset: Exclude<ArtifactDesignPreset, "auto">;
  visualLevel: ArtifactVisualLevel;
  assetPolicy: ArtifactAssetPolicy;
  layouts: string[];
  assetSources: ArtifactAssetPlanItem[];
  skippedAssets: ArtifactAssetPlanItem[];
  validation: ArtifactValidationCheck[];
  guideReferences: ArtifactGuideReference[];
  localPath?: string;
  google: ArtifactGoogleImportStatus;
  residualRisks: string[];
}

interface ArtifactDesignPlanInput {
  kind: ArtifactKind;
  title: string;
  format?: string;
  body?: string;
  sections?: Array<{ heading?: string; title?: string; body?: string; bullets?: string[] }>;
  slides?: Array<{ title?: string; bullets?: string[]; speakerNotes?: string }>;
  design?: unknown;
  destination?: unknown;
}

const RAW_OUTPUT_FORMATS = new Set(["json", "csv", "txt", "text", "log", "logs", "code"]);

const ARTIFACT_LAYOUT_LIBRARY: Record<ArtifactKind, ArtifactLayoutPlan[]> = {
  presentation: [
    { name: "hero", purpose: "Open with a large title, subtitle, and visual anchor." },
    { name: "title-body", purpose: "Pair one main idea with concise supporting points." },
    { name: "two-column", purpose: "Compare related concepts without crowding." },
    { name: "image-text", purpose: "Balance a visual with short explanatory copy." },
    { name: "icon-row", purpose: "Scan a set of simple categories or steps." },
    { name: "stat-callout", purpose: "Elevate a key metric or concise takeaway." },
    { name: "timeline", purpose: "Show sequence, progress, or phased work." },
    { name: "comparison", purpose: "Contrast options, tradeoffs, or before/after states." },
    { name: "section-divider", purpose: "Create breathing room between major topics." },
    { name: "closing", purpose: "End with the key action or summary." },
  ],
  document: [
    { name: "report-cover", purpose: "Present title, audience, and document purpose clearly." },
    { name: "callout-box", purpose: "Highlight summary, warning, or recommendation blocks." },
    { name: "two-column", purpose: "Create scannable side-by-side detail where useful." },
    { name: "stat-callout", purpose: "Lift key evidence or numbers from body prose." },
    { name: "timeline", purpose: "Show phases or chronological progress." },
    { name: "comparison", purpose: "Contrast options, recommendations, or tradeoffs." },
  ],
  html: [
    { name: "report-cover", purpose: "Provide a strong opening band with clear document context." },
    { name: "callout-box", purpose: "Make important takeaways stand out from body text." },
    { name: "icon-row", purpose: "Summarize repeated ideas as compact visual rows." },
    { name: "comparison", purpose: "Support fast scanning and evaluation." },
  ],
  pdf: [
    { name: "report-cover", purpose: "Give generated PDFs a consistent first-page hierarchy." },
    { name: "callout-box", purpose: "Reserve emphasis for key findings or recommendations." },
    { name: "title-body", purpose: "Keep print output legible and predictable." },
  ],
  data: [{ name: "plain-data", purpose: "Preserve machine-readable output without decoration." }],
};

const PRESET_TOKENS: Record<Exclude<ArtifactDesignPreset, "auto">, ArtifactColorTokens> = {
  "clean-professional": {
    background: "F8FAFC",
    surface: "FFFFFF",
    text: "0F172A",
    mutedText: "475569",
    accent: "0EA5E9",
    accent2: "14B8A6",
    accent3: "F59E0B",
    border: "CBD5E1",
  },
  education: {
    background: "F7F9FC",
    surface: "FFFFFF",
    text: "172554",
    mutedText: "475569",
    accent: "2563EB",
    accent2: "16A34A",
    accent3: "F97316",
    border: "BFDBFE",
  },
  wellness: {
    background: "F6FBF8",
    surface: "FFFFFF",
    text: "12312A",
    mutedText: "4B635C",
    accent: "10B981",
    accent2: "38BDF8",
    accent3: "F59E0B",
    border: "B7E4D3",
  },
  pitch: {
    background: "F9FAFB",
    surface: "FFFFFF",
    text: "111827",
    mutedText: "4B5563",
    accent: "7C3AED",
    accent2: "06B6D4",
    accent3: "F97316",
    border: "DDD6FE",
  },
  "technical-report": {
    background: "F8FAFC",
    surface: "FFFFFF",
    text: "111827",
    mutedText: "475569",
    accent: "2563EB",
    accent2: "059669",
    accent3: "DC2626",
    border: "CBD5E1",
  },
  "cyberpunk-ops": {
    background: "07111F",
    surface: "0E1B2D",
    text: "E6F6FF",
    mutedText: "9FB6C9",
    accent: "22D3EE",
    accent2: "2DD4BF",
    accent3: "F472B6",
    border: "164E63",
  },
};

export const ARTIFACT_DESIGN_GUIDES: ArtifactGuideReference[] = [
  {
    title: "Microsoft presentation tips",
    url: "https://support.microsoft.com/en-us/office/tips-for-creating-and-delivering-an-effective-presentation-f43156b0-20d2-4c51-8345-0c337cefb88b",
    ruleSummary: "Keep slides focused, legible, and visually supportive of the spoken or written message.",
  },
  {
    title: "Canva visual hierarchy",
    url: "https://www.canva.com/learn/visual-hierarchy/",
    ruleSummary: "Use scale, contrast, grouping, and spacing to make the most important information obvious first.",
  },
  {
    title: "IBM color accessibility guidance",
    url: "https://www.ibm.com/design/language/color",
    ruleSummary: "Treat color as a system with contrast, semantic meaning, and accessibility constraints.",
  },
  {
    title: "Google Drive upload conversion docs",
    url: "https://developers.google.com/drive/api/v3/manage-uploads",
    ruleSummary:
      "Convert office files through Drive upload workflows when a Google workspace destination is configured.",
  },
  {
    title: "ClawHub PPTX skill reference pattern",
    url: "https://clawhub.ai/liuyingduo/pptx-2",
    ruleSummary: "Prefer a proven PPTX library path, then validate package structure and generated slide contents.",
  },
];

export function createArtifactDesignPlan(input: ArtifactDesignPlanInput): ArtifactDesignPlan {
  const design = normalizeArtifactDesignRequest(input.design);
  const destination = normalizeArtifactDestinationRequest(input.destination, input.kind);
  const mode = resolveDesignMode(input, design);
  const visualLevel = resolveVisualLevel(mode, design.visualLevel);
  const preset = resolvePreset(input, design, mode);
  const assetPolicy = resolveAssetPolicy(mode, design.assetPolicy, input);
  const tokens = applyBrandColors(PRESET_TOKENS[preset], design.brand);
  return {
    kind: input.kind,
    mode,
    preset,
    visualLevel,
    assetPolicy,
    audience: design.audience,
    brand: design.brand,
    tokens,
    typography: resolveTypography(design.brand),
    layouts:
      mode === "plain" || mode === "minimal" ? ARTIFACT_LAYOUT_LIBRARY.data : ARTIFACT_LAYOUT_LIBRARY[input.kind],
    assetPlan: buildAssetPlan(input, mode, assetPolicy),
    validationChecks: buildValidationChecks(input.kind, mode, destination),
    guideReferences: ARTIFACT_DESIGN_GUIDES,
    destination,
    outputNotes: buildOutputNotes(input.kind, destination),
  };
}

export function normalizeArtifactDesignRequest(value: unknown): ArtifactDesignRequest {
  if (!isRecord(value)) {
    return {};
  }
  return {
    mode: parseDesignMode(value.mode),
    preset: parsePreset(value.preset),
    visualLevel: parseVisualLevel(value.visualLevel),
    assetPolicy: parseAssetPolicy(value.assetPolicy),
    audience: asNonEmptyString(value.audience),
    brand: normalizeBrand(value.brand),
  };
}

export function normalizeArtifactDestinationRequest(value: unknown, kind: ArtifactKind): ArtifactDestinationRequest {
  if (typeof value === "string") {
    return destinationFromString(value, kind);
  }
  if (!isRecord(value)) {
    return { kind: "local", convert: false };
  }
  const rawKind = asNonEmptyString(value.kind) ?? asNonEmptyString(value.type) ?? asNonEmptyString(value.destination);
  const destination = destinationFromString(rawKind ?? "local", kind);
  return {
    ...destination,
    folderId: asNonEmptyString(value.folderId) ?? asNonEmptyString(value.folder),
    title: asNonEmptyString(value.title),
    convert: typeof value.convert === "boolean" ? value.convert : destination.convert,
  };
}

export function buildArtifactDesignReport(
  plan: ArtifactDesignPlan,
  output: { localPath?: string; google?: Partial<ArtifactGoogleImportStatus>; residualRisks?: string[] } = {},
): ArtifactDesignReport {
  const google = resolveGoogleImportStatus(plan.destination, output.google);
  return {
    mode: plan.mode,
    preset: plan.preset,
    visualLevel: plan.visualLevel,
    assetPolicy: plan.assetPolicy,
    layouts: plan.layouts.map((layout) => layout.name),
    assetSources: plan.assetPlan.filter((asset) => asset.status !== "skipped"),
    skippedAssets: plan.assetPlan.filter((asset) => asset.status === "skipped"),
    validation: plan.validationChecks,
    guideReferences: plan.guideReferences,
    localPath: output.localPath,
    google,
    residualRisks: output.residualRisks ?? buildResidualRisks(plan, google),
  };
}

export function cssColor(hex: string): string {
  return `#${hex.replace(/^#/, "")}`;
}

function resolveDesignMode(input: ArtifactDesignPlanInput, design: ArtifactDesignRequest): ArtifactDesignMode {
  if (design.mode && design.mode !== "auto") {
    return design.mode;
  }
  const rawFormat = (input.format ?? "").toLowerCase();
  const titleBody = `${input.title} ${input.body ?? ""}`.toLowerCase();
  if (RAW_OUTPUT_FORMATS.has(rawFormat) || /\b(json|csv|logs?|plain text|raw data|code block)\b/u.test(titleBody)) {
    return "minimal";
  }
  return "polished";
}

function resolveVisualLevel(mode: ArtifactDesignMode, requested?: ArtifactVisualLevel): ArtifactVisualLevel {
  if (requested) {
    return requested;
  }
  return mode === "minimal" || mode === "plain" ? "minimal" : "polished";
}

function resolvePreset(
  input: ArtifactDesignPlanInput,
  design: ArtifactDesignRequest,
  mode: ArtifactDesignMode,
): Exclude<ArtifactDesignPreset, "auto"> {
  if (design.preset && design.preset !== "auto") {
    return design.preset;
  }
  if (mode === "minimal" || mode === "plain") {
    return "clean-professional";
  }
  const text = collectContentText(input);
  if (/\b(walk|walking|wellness|health|stress|sleep|fitness|mindful|mood|energy)\b/u.test(text)) {
    return "wellness";
  }
  if (/\b(lesson|course|teach|student|classroom|guide|worksheet|learn|training)\b/u.test(text)) {
    return "education";
  }
  if (/\b(pitch|investor|fundraise|market|revenue|growth|proposal|offer)\b/u.test(text)) {
    return "pitch";
  }
  if (/\b(api|runtime|security|audit|report|technical|architecture|benchmark|incident|diagnostic)\b/u.test(text)) {
    return "technical-report";
  }
  if (/\b(cyberpunk|mission control|ops|observability|operator|neon|gateway)\b/u.test(text)) {
    return "cyberpunk-ops";
  }
  return "clean-professional";
}

function resolveAssetPolicy(
  mode: ArtifactDesignMode,
  requested: ArtifactAssetPolicy | undefined,
  input: ArtifactDesignPlanInput,
): ArtifactAssetPolicy {
  if (requested && requested !== "auto") {
    return requested;
  }
  if (mode === "minimal" || mode === "plain") {
    return "none";
  }
  const text = collectContentText(input);
  if (/\b(screenshot|public figure|historical|current|map|place|product|logo|photo of)\b/u.test(text)) {
    return "web-first";
  }
  return "generated-first";
}

function buildAssetPlan(
  input: ArtifactDesignPlanInput,
  mode: ArtifactDesignMode,
  assetPolicy: ArtifactAssetPolicy,
): ArtifactAssetPlanItem[] {
  if (mode === "minimal" || mode === "plain" || assetPolicy === "none") {
    return [
      {
        id: "plain-output",
        type: "built_in",
        role: "provenance",
        status: "skipped",
        description: "Visual styling intentionally minimized for plain or machine-readable output.",
        altText: "No decorative visual assets requested.",
        reason: "Plain output requested or inferred.",
      },
    ];
  }
  const base: ArtifactAssetPlanItem[] = [
    {
      id: "renderer-generated-visual",
      type: "generated",
      role: "hero",
      status: "planned",
      description: `Renderer-generated abstract visual system for ${input.title}.`,
      altText: `Abstract visual supporting ${input.title}.`,
      source: "local renderer",
      license: "Generated locally by GoatCitadel",
    },
    {
      id: "built-in-shapes-icons",
      type: "built_in",
      role: "icon",
      status: "planned",
      description: "Built-in shapes, dividers, and callout accents shared by artifact renderers.",
      altText: "Decorative geometric accents and section markers.",
      source: "GoatCitadel renderer primitives",
      license: "Generated locally by GoatCitadel",
    },
  ];
  if (assetPolicy === "web-first") {
    base.unshift({
      id: "web-factual-image",
      type: "web",
      role: "supporting",
      status: "skipped",
      description: "Factual web imagery was preferred by the design brief.",
      altText: `Factual visual evidence for ${input.title}.`,
      reason: "No approved source/license metadata was supplied to this local renderer call.",
    });
  }
  if (assetPolicy === "generated-first") {
    base.push({
      id: "web-fallback-image",
      type: "web",
      role: "supporting",
      status: "skipped",
      description: "Web image fallback for real-world visuals.",
      altText: `Optional sourced image for ${input.title}.`,
      reason: "Generated/local visuals were available; web assets require source and license metadata.",
    });
  }
  return base;
}

function buildValidationChecks(
  kind: ArtifactKind,
  mode: ArtifactDesignMode,
  destination: ArtifactDestinationRequest,
): ArtifactValidationCheck[] {
  const checks: ArtifactValidationCheck[] = [
    {
      id: "hierarchy",
      label: "Readable hierarchy",
      status: mode === "minimal" || mode === "plain" ? "skipped" : "planned",
      detail: "Headings, body text, and callouts should have clear scale and spacing.",
    },
    {
      id: "contrast",
      label: "Color contrast",
      status: mode === "minimal" || mode === "plain" ? "skipped" : "planned",
      detail: "Preset colors are selected for high text/background contrast.",
    },
    {
      id: "asset-provenance",
      label: "Asset provenance",
      status: "planned",
      detail: "Each generated, web, local, or built-in asset must be reflected in the tool design report.",
    },
  ];
  if (kind === "presentation") {
    checks.push({
      id: "pptx-package",
      label: "PowerPoint package validity",
      status: "planned",
      detail: "Deck output should include valid relationships, theme parts, slide content, and visual media.",
    });
  }
  if (kind === "document" || kind === "html" || kind === "pdf") {
    checks.push({
      id: "document-structure",
      label: "Document structure",
      status: "planned",
      detail: "Document output should preserve headings, body text, sections, callouts, and relationships.",
    });
  }
  if (destination.kind !== "local") {
    checks.push({
      id: "google-import",
      label: "Google import status",
      status: "planned",
      detail: "Local DOCX/PPTX output should be ready for Drive conversion when a connector is configured.",
    });
  }
  return checks;
}

function resolveGoogleImportStatus(
  destination: ArtifactDestinationRequest,
  override?: Partial<ArtifactGoogleImportStatus>,
): ArtifactGoogleImportStatus {
  if (destination.kind === "local") {
    return { requested: false, status: "not_requested", mode: "convert", ...override };
  }
  return {
    requested: true,
    status: "not_configured",
    mode: "convert",
    reason: "Google Drive import/conversion adapter is not configured for this local tool executor.",
    ...override,
  };
}

function buildResidualRisks(plan: ArtifactDesignPlan, google: ArtifactGoogleImportStatus): string[] {
  const risks: string[] = [];
  if (plan.assetPlan.some((asset) => asset.status === "skipped")) {
    risks.push(
      "Some external or web assets were skipped because source, license, provider, or approval data was unavailable.",
    );
  }
  if (google.requested && google.status !== "imported") {
    risks.push("Google import was requested, but only the local artifact was produced in this runtime.");
  }
  if (plan.kind === "pdf") {
    risks.push(
      "PDF output uses the existing lightweight renderer and has less visual richness than DOCX, HTML, or PPTX.",
    );
  }
  return risks;
}

function buildOutputNotes(kind: ArtifactKind, destination: ArtifactDestinationRequest): string[] {
  const notes = [`Renderer-neutral design brief generated for ${kind} output.`];
  if (destination.kind !== "local") {
    notes.push(
      "Google destination uses local artifact generation plus Drive import/conversion when a connector is available.",
    );
  }
  return notes;
}

function applyBrandColors(tokens: ArtifactColorTokens, brand?: ArtifactBrandInput): ArtifactColorTokens {
  const colors = brand?.colors?.map(normalizeHexColor).filter((color): color is string => Boolean(color)) ?? [];
  if (colors.length === 0) {
    return tokens;
  }
  return {
    ...tokens,
    accent: colors[0] ?? tokens.accent,
    accent2: colors[1] ?? tokens.accent2,
    accent3: colors[2] ?? tokens.accent3,
  };
}

function resolveTypography(brand?: ArtifactBrandInput): ArtifactTypographyTokens {
  const fonts = brand?.fonts?.filter((font) => font.trim().length > 0) ?? [];
  return {
    headingFont: fonts[0] ?? "Aptos Display",
    bodyFont: fonts[1] ?? fonts[0] ?? "Aptos",
  };
}

function destinationFromString(raw: string, kind: ArtifactKind): ArtifactDestinationRequest {
  const value = raw.trim().toLowerCase();
  if (value === "google" || value === "google-drive" || value === "drive") {
    return {
      kind: kind === "presentation" ? "google-slides" : "google-docs",
      convert: true,
    };
  }
  if (value === "google-slides" || value === "slides") {
    return { kind: "google-slides", convert: true };
  }
  if (value === "google-docs" || value === "docs") {
    return { kind: "google-docs", convert: true };
  }
  return { kind: "local", convert: false };
}

function normalizeBrand(value: unknown): ArtifactBrandInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    name: asNonEmptyString(value.name),
    colors: Array.isArray(value.colors)
      ? value.colors
          .map((color) => String(color))
          .filter(Boolean)
          .slice(0, 6)
      : undefined,
    fonts: Array.isArray(value.fonts)
      ? value.fonts
          .map((font) => String(font))
          .filter(Boolean)
          .slice(0, 3)
      : undefined,
    logoPath: asNonEmptyString(value.logoPath),
  };
}

function parseDesignMode(value: unknown): ArtifactDesignMode | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "auto":
      return "auto";
    case "polished":
    case "designed":
      return "polished";
    case "minimal":
    case "off":
      return "minimal";
    case "plain":
      return "plain";
    default:
      return undefined;
  }
}

function parsePreset(value: unknown): ArtifactDesignPreset | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "auto":
    case "clean-professional":
    case "education":
    case "wellness":
    case "pitch":
    case "technical-report":
    case "cyberpunk-ops":
      return raw;
    default:
      return undefined;
  }
}

function parseVisualLevel(value: unknown): ArtifactVisualLevel | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "minimal":
    case "polished":
    case "rich":
      return raw;
    default:
      return undefined;
  }
}

function parseAssetPolicy(value: unknown): ArtifactAssetPolicy | undefined {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (raw) {
    case "auto":
    case "generated-first":
    case "web-first":
    case "built-in-only":
    case "none":
      return raw;
    default:
      return undefined;
  }
}

function collectContentText(input: ArtifactDesignPlanInput): string {
  const sectionText =
    input.sections
      ?.flatMap((section) => [section.heading, section.title, section.body, ...(section.bullets ?? [])])
      .filter(Boolean)
      .join(" ") ?? "";
  const slideText =
    input.slides
      ?.flatMap((slide) => [slide.title, ...(slide.bullets ?? []), slide.speakerNotes])
      .filter(Boolean)
      .join(" ") ?? "";
  return `${input.title} ${input.body ?? ""} ${sectionText} ${slideText}`.toLowerCase();
}

function normalizeHexColor(value: string): string | undefined {
  const color = value.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/u.test(color) ? color : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
