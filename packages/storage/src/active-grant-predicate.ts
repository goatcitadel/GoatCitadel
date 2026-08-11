import type { DatabaseClient } from "./db.js";

/**
 * Predicate asserting a durable auth grant expiry column is a canonical zoned
 * instant strictly in the future. Non-canonical text fails closed (treated as
 * expired) in both dialects so a malformed row can never keep a grant-bound
 * owner (mobile push, mobile approval keys) alive.
 */
export function buildActiveGrantExpiryPredicate(dialect: DatabaseClient["dialect"], expression: string): string {
  if (dialect === "postgres") {
    const canonical = `(${expression} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$')`;
    return `COALESCE(${canonical} AND isfinite(gc_try_parse_timestamptz(${expression})) AND gc_try_parse_timestamptz(${expression}) > clock_timestamp(), FALSE)`;
  }
  const canonical = buildSqliteCanonicalZonedInstantPredicate(expression);
  return `COALESCE(${canonical} AND julianday(${expression}) > julianday('now'), 0)`;
}

function buildSqliteCanonicalZonedInstantPredicate(expression: string): string {
  const base = `substr(${expression}, 1, 19)`;
  const basePattern = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]";
  const zuluFraction = `substr(${expression}, 21, length(${expression}) - 21)`;
  const offsetFraction = `substr(${expression}, 21, length(${expression}) - 26)`;
  const offsetShape = (signPosition: string) => `
    substr(${expression}, ${signPosition}, 1) IN ('+', '-')
    AND substr(${expression}, ${signPosition} + 3, 1) = ':'
    AND substr(${expression}, ${signPosition} + 1, 2) NOT GLOB '*[^0-9]*'
    AND substr(${expression}, ${signPosition} + 4, 2) NOT GLOB '*[^0-9]*'
  `;
  return `(
    typeof(${expression}) = 'text'
    AND ${base} GLOB '${basePattern}'
    AND (
      (length(${expression}) = 20 AND substr(${expression}, 20, 1) = 'Z')
      OR (length(${expression}) = 25 AND ${offsetShape("20")})
      OR (
        substr(${expression}, 20, 1) = '.'
        AND (
          (
            length(${expression}) >= 22
            AND length(${expression}) <= 30
            AND substr(${expression}, -1, 1) = 'Z'
            AND ${zuluFraction} <> ''
            AND ${zuluFraction} NOT GLOB '*[^0-9]*'
          )
          OR (
            length(${expression}) >= 27
            AND length(${expression}) <= 35
            AND ${offsetShape(`length(${expression}) - 5`)}
            AND ${offsetFraction} <> ''
            AND ${offsetFraction} NOT GLOB '*[^0-9]*'
          )
        )
      )
    )
  )`;
}
