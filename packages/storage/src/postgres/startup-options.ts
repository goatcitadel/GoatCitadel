const UTF8_CLIENT_ENCODING_OPTION = "-c client_encoding=UTF8";

export interface PostgresConnectionStringStartupConfig {
  connectionString: string;
  options: string;
}

/**
 * Preserves operator-supplied PostgreSQL startup options while keeping the
 * storage client's UTF-8 connection contract authoritative.
 *
 * `pg` gives an explicit `options` Pool setting precedence over the same URL
 * query parameter. Both pool builders set that field, so replacing rather than
 * merging it silently discards settings such as an isolated `search_path`.
 */
export function buildPostgresStartupOptions(connectionString?: string): string {
  const configured = readPostgresStartupOptions(connectionString);
  return configured ? `${configured} ${UTF8_CLIENT_ENCODING_OPTION}` : UTF8_CLIENT_ENCODING_OPTION;
}

/**
 * `pg` parses a connection string after the explicit Pool fields and lets URL
 * query values win. When the URL already has `options`, write the merged value
 * back into that URL as well; otherwise the explicit UTF-8 suffix is discarded
 * by the driver's precedence rule.
 */
export function buildPostgresConnectionStringStartupConfig(
  connectionString: string,
): PostgresConnectionStringStartupConfig {
  const normalized = connectionString.trim();
  const options = buildPostgresStartupOptions(normalized);
  let parsed: URL | undefined;
  try {
    parsed = parsePostgresUrl(normalized);
  } catch {
    return { connectionString: normalized, options };
  }
  if (!parsed || !readPostgresStartupOptionsFromUrl(parsed)) {
    return { connectionString: normalized, options };
  }
  parsed.searchParams.set("options", options);
  return { connectionString: parsed.toString(), options };
}

function readPostgresStartupOptions(connectionString: string | undefined): string | undefined {
  const normalized = connectionString?.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    const url = parsePostgresUrl(normalized);
    return url ? readPostgresStartupOptionsFromUrl(url) : undefined;
  } catch {
    // Leave connection-string validation to `pg`; the pool will still receive
    // the original value and report its canonical parse/connection error.
    return undefined;
  }
}

function parsePostgresUrl(connectionString: string): URL | undefined {
  const url = new URL(connectionString);
  return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : undefined;
}

function readPostgresStartupOptionsFromUrl(url: URL): string | undefined {
  return url.searchParams.get("options")?.trim() || undefined;
}
