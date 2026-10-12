/**
 * The DESIGN.md brand block: a fenced code block whose info string is `brand`, holding
 * `key: value` lines. It is the one machine-readable part of a workspace design document;
 * the gateway hands it to deck and document renderers as the artifact brand when the model
 * supplied none. Pure: no filesystem access.
 */

/** Same shape as the policy-engine `ArtifactBrandInput`; this package never imports that package. */
export interface DesignBrand {
  name?: string;
  colors?: string[];
  fonts?: string[];
  logoPath?: string;
}

export const DESIGN_BRAND_MAX_COLORS = 6;
export const DESIGN_BRAND_MAX_FONTS = 3;
export const DESIGN_BRAND_MAX_NAME_LENGTH = 80;

export const DESIGN_BRAND_BLOCK_EXAMPLE = [
  "```brand",
  "name: Acme Cooperative",
  "colors: #0f172a, #0ea5e9, #f8fafc",
  "fonts: Inter, Source Serif 4",
  "logo: assets/logo.svg",
  "```",
].join("\n");

const BRAND_FENCE = /^[ \t]*```[ \t]*brand[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/imu;
const HEX_COLOR = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** Parse the first `brand` block of a DESIGN.md; `undefined` when there is none or it yields nothing. */
export function parseDesignBrandBlock(markdown: string): DesignBrand | undefined {
  const body = BRAND_FENCE.exec(markdown)?.[1];
  if (!body) return undefined;
  const fields = parseFields(body);
  const name = fields.get("name")?.slice(0, DESIGN_BRAND_MAX_NAME_LENGTH);
  const colors = splitList(fields.get("colors"))
    .map(normalizeHexColor)
    .filter((color): color is string => Boolean(color))
    .slice(0, DESIGN_BRAND_MAX_COLORS);
  const fonts = splitList(fields.get("fonts")).slice(0, DESIGN_BRAND_MAX_FONTS);
  const logoPath = normalizeLogoPath(fields.get("logo"));
  const brand: DesignBrand = {
    ...(name ? { name } : {}),
    ...(colors.length > 0 ? { colors } : {}),
    ...(fonts.length > 0 ? { fonts } : {}),
    ...(logoPath ? { logoPath } : {}),
  };
  return Object.keys(brand).length > 0 ? brand : undefined;
}

function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key && value && !fields.has(key)) fields.set(key, value);
  }
  return fields;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeHexColor(value: string): string | undefined {
  if (!HEX_COLOR.test(value)) return undefined;
  const hex = value.replace(/^#/u, "").toLowerCase();
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return `#${expanded}`;
}

/** A logo path must stay inside the workspace: relative, forward slashes, no `..`, no scheme, no drive. */
function normalizeLogoPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("\\") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return value;
}
