import type { DatabaseSync } from "node:sqlite";

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS channel_delivery_parts (
    part_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES comms_deliveries(delivery_id),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    part_index INTEGER NOT NULL CHECK (part_index >= 0 AND part_index < 2048),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    claim_expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('prepared', 'waiting_approval', 'dispatching', 'sent', 'failed', 'manual_reconciliation_required')),
    approval_id TEXT UNIQUE REFERENCES approvals(approval_id),
    provider_delivery_id TEXT UNIQUE REFERENCES comms_deliveries(delivery_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(delivery_id, attempt, part_index),
    CHECK (status <> 'waiting_approval' OR approval_id IS NOT NULL),
    CHECK (status NOT IN ('dispatching', 'sent') OR provider_delivery_id IS NOT NULL),
    CHECK (provider_delivery_id IS NULL OR provider_delivery_id <> delivery_id)
  );
  CREATE INDEX IF NOT EXISTS idx_channel_delivery_parts_parent ON channel_delivery_parts(delivery_id, attempt, part_index);
`;

const INVALID_TRANSITION_SQL = `
  NEW.part_id <> OLD.part_id OR NEW.delivery_id <> OLD.delivery_id OR
  NEW.attempt <> OLD.attempt OR NEW.part_index <> OLD.part_index OR
  NEW.payload_hash <> OLD.payload_hash OR NEW.request_hash <> OLD.request_hash OR
  NEW.claim_expires_at <> OLD.claim_expires_at OR NEW.created_at <> OLD.created_at OR
  NEW.revision <> OLD.revision + 1 OR
  (OLD.approval_id IS NOT NULL AND (NEW.approval_id IS NULL OR NEW.approval_id <> OLD.approval_id)) OR
  (OLD.provider_delivery_id IS NOT NULL AND (NEW.provider_delivery_id IS NULL OR NEW.provider_delivery_id <> OLD.provider_delivery_id)) OR
  NOT (
    (OLD.status = 'prepared' AND NEW.status IN ('waiting_approval', 'dispatching', 'failed')) OR
    (OLD.status = 'waiting_approval' AND NEW.status IN ('dispatching', 'failed')) OR
    (OLD.status = 'dispatching' AND NEW.status IN ('sent', 'failed', 'manual_reconciliation_required'))
  )
`;

export const CHANNEL_DELIVERY_PARTS_SQLITE_SQL = `${TABLE_SQL}
  CREATE TRIGGER trg_channel_delivery_parts_insert BEFORE INSERT ON channel_delivery_parts
  WHEN NEW.status <> 'prepared' OR NEW.revision <> 1 OR NEW.approval_id IS NOT NULL OR NEW.provider_delivery_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'channel delivery parts must begin prepared'); END;
  CREATE TRIGGER trg_channel_delivery_parts_guard BEFORE UPDATE ON channel_delivery_parts
  WHEN ${INVALID_TRANSITION_SQL}
  BEGIN SELECT RAISE(ABORT, 'channel delivery part identity or transition is invalid'); END;
  CREATE TRIGGER trg_channel_delivery_parts_no_delete BEFORE DELETE ON channel_delivery_parts
  BEGIN SELECT RAISE(ABORT, 'channel delivery part evidence cannot be deleted'); END;
`;

export function createChannelDeliveryPartsSchema(db: Pick<DatabaseSync, "exec">): void {
  db.exec(CHANNEL_DELIVERY_PARTS_SQLITE_SQL);
}

export const CHANNEL_DELIVERY_PARTS_POSTGRES_SQL = `${TABLE_SQL}
  -- Fresh PostgreSQL bootstrap renders SQLite columns, keys and indexes. The
  -- forward migration also installs the CHECKs that bootstrap does not render.
  ALTER TABLE channel_delivery_parts DROP CONSTRAINT IF EXISTS gc_channel_delivery_parts_shape;
  ALTER TABLE channel_delivery_parts ADD CONSTRAINT gc_channel_delivery_parts_shape CHECK (
    attempt > 0 AND part_index >= 0 AND part_index < 2048 AND revision > 0 AND
    length(payload_hash) = 64 AND length(request_hash) = 64 AND
    status IN ('prepared', 'waiting_approval', 'dispatching', 'sent', 'failed', 'manual_reconciliation_required') AND
    (status <> 'waiting_approval' OR approval_id IS NOT NULL) AND
    (status NOT IN ('dispatching', 'sent') OR provider_delivery_id IS NOT NULL) AND
    (provider_delivery_id IS NULL OR provider_delivery_id <> delivery_id)
  );
  CREATE OR REPLACE FUNCTION gc_channel_delivery_parts_guard() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'prepared' OR NEW.revision <> 1 OR NEW.approval_id IS NOT NULL OR NEW.provider_delivery_id IS NOT NULL THEN
        RAISE EXCEPTION 'channel delivery parts must begin prepared' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'channel delivery part evidence cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF ${INVALID_TRANSITION_SQL} THEN
      RAISE EXCEPTION 'channel delivery part identity or transition is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS trg_channel_delivery_parts_guard ON channel_delivery_parts;
  CREATE TRIGGER trg_channel_delivery_parts_guard BEFORE INSERT OR UPDATE OR DELETE ON channel_delivery_parts
    FOR EACH ROW EXECUTE FUNCTION gc_channel_delivery_parts_guard();
`;
