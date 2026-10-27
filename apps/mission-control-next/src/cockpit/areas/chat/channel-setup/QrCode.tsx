import { useMemo } from "react";
import { encode } from "uqr";

/** Light modules drawn around the code. Scanners need a quiet border; two modules is enough for a phone camera. */
const BORDER_MODULES = 2;

/** One rectangle per run of dark modules in a row, joined into a single path so the code is one drawn shape. */
function darkModulePath(matrix: readonly (readonly boolean[])[]): string {
  const runs: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      runs.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  });
  return runs.join("");
}

/**
 * A QR code for `value`, drawn here rather than fetched, so nothing about the link leaves this computer. It is always
 * dark on a light square, in both themes: scanners read dark modules on a light ground, so the code must not follow
 * the theme.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: BORDER_MODULES });
    return { size: data.length, path: darkModulePath(data) };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-44 shrink-0 rounded-md border border-line"
    >
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
