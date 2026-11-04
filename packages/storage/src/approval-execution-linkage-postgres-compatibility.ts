/** PostgreSQL forward repair of the approval execution linkage projector. */
export const APPROVAL_EXECUTION_LINKAGE_JSON_COMPATIBILITY_POSTGRES_SQL = String.raw`CREATE OR REPLACE FUNCTION gc_approval_execution_linkage(canonical TEXT, payload TEXT, preview TEXT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $gc_project$
DECLARE
  sources TEXT[] := ARRAY[canonical, payload, preview];
  source_index INTEGER;
  raw TEXT;
  doubled_tildes TEXT;
  representable TEXT;
  escaped_nul BOOLEAN;
  candidate JSONB;
  normalized JSONB;
  projected JSONB;
  unsupported_binding BOOLEAN;
  linkage_whitespace CONSTANT TEXT :=
    chr(32) || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
    || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
    || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
BEGIN
  FOR source_index IN 1..3 LOOP
    raw := sources[source_index];
    escaped_nul := FALSE;

    BEGIN
      candidate := raw::jsonb;
    EXCEPTION
      WHEN invalid_text_representation THEN
        candidate := NULL;
      WHEN untranslatable_character THEN
        -- Use an injective spelling only on the exceptional path. Pair capture
        -- keeps literal backslashes; the lookbehind prevents starting inside a run.
        doubled_tildes := regexp_replace(
          replace(raw COLLATE pg_catalog."C", '~', '~~'),
          $gc_tilde$(?<!\\)((?:\\\\)*)\\u007[eE]$gc_tilde$,
          $gc_tilde_replacement$\1~~$gc_tilde_replacement$,
          'g'
        );
        representable := regexp_replace(
          doubled_tildes COLLATE pg_catalog."C",
          $gc_nul$(?<!\\)((?:\\\\)*)\\u0000$gc_nul$,
          $gc_nul_replacement$\1~n$gc_nul_replacement$,
          'g'
        );
        IF representable COLLATE pg_catalog."C" = doubled_tildes THEN
          RAISE;
        END IF;
        BEGIN
          candidate := representable::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN
          candidate := NULL;
        END;
        escaped_nul := TRUE;
    END;

    IF source_index > 1 THEN
      candidate := candidate -> '__gcApprovalLinkage';
    END IF;
    IF jsonb_typeof(candidate) = 'object' THEN
      SELECT jsonb_object_agg(key, value) INTO normalized
      FROM jsonb_each(candidate)
      WHERE jsonb_typeof(value) = 'string'
        AND length(btrim(value #>> '{}', linkage_whitespace)) > 0;
      IF normalized IS NULL THEN
        CONTINUE;
      END IF;
      IF NOT escaped_nul THEN
        RETURN normalized;
      END IF;

      -- The source is already authoritative. These exact field names contain
      -- no tildes, so an encoded NUL in a key cannot create a binding.
      SELECT jsonb_object_agg(key, replace(value, '~~', '~')),
             COALESCE(bool_or(strpos(regexp_replace(value COLLATE pg_catalog."C", '~~', '', 'g'), '~n') > 0), FALSE)
        INTO projected, unsupported_binding
      FROM (VALUES
        ('workspaceId', normalized ->> 'workspaceId'),
        ('runId', normalized ->> 'runId'),
        ('durableRunId', normalized ->> 'durableRunId'),
        ('sessionId', normalized ->> 'sessionId')
      ) AS bindings(key, value)
      WHERE value IS NOT NULL;
      IF unsupported_binding THEN
        -- NULL session is a wildcard in listByRunLinkage. Omit the whole row
        -- when any selected index field cannot be represented faithfully.
        RETURN NULL;
      END IF;
      RETURN projected;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$gc_project$;`;
