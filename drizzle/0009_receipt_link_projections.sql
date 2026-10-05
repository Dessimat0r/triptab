ALTER TABLE trips ADD COLUMN receipt_link_version integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Only receipt-link metadata is projected. The ledger and append-only events
-- remain authoritative; no profile, financial, message or image content is copied.
CREATE TABLE `current_receipt_links` (
  `trip_id` text NOT NULL REFERENCES `trips`(`id`) ON DELETE CASCADE,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `expense_id` text,
  `source_draft_id` text,
  `receipt_id` text,
  `has_expense_link` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `current_receipt_links_entity_idx` ON `current_receipt_links` (`trip_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `current_receipt_links_expense_idx` ON `current_receipt_links` (`trip_id`,`entity_type`,`expense_id`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `current_receipt_links_source_idx` ON `current_receipt_links` (`trip_id`,`entity_type`,`source_draft_id`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `current_receipt_links_receipt_idx` ON `current_receipt_links` (`trip_id`,`entity_type`,`receipt_id`,`entity_id`);
--> statement-breakpoint
-- Trip writes and this projection commit or roll back together, including
-- invitation acceptance. iif avoids CASE/END in Wrangler's SQL tokenizer.
CREATE TRIGGER current_receipt_links_insert AFTER INSERT ON trips
BEGIN
  DELETE FROM current_receipt_links WHERE trip_id = NEW.id;
  INSERT INTO current_receipt_links (trip_id,entity_type,entity_id,expense_id,source_draft_id,receipt_id,has_expense_link)
  SELECT NEW.id,'expense',json_extract(entry.value,'$.id'),NULL,
  iif(json_type(entry.value,'$.sourceDraftId') = 'text',json_extract(entry.value,'$.sourceDraftId'),NULL),
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),0
FROM json_each(NEW.data,'$.expenses') entry WHERE json_type(entry.value,'$.id') = 'text'
UNION ALL
SELECT NEW.id,'draft',json_extract(entry.value,'$.id'),
  iif(json_type(entry.value,'$.expenseId') = 'text',json_extract(entry.value,'$.expenseId'),NULL),NULL,
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),
  json_extract(entry.value,'$.expenseId') IS NOT NULL
FROM json_each(NEW.data,'$.drafts') entry WHERE json_type(entry.value,'$.id') = 'text';
  UPDATE trips SET receipt_link_version = receipt_link_version + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER current_receipt_links_update AFTER UPDATE OF data,id ON trips
WHEN OLD.data <> NEW.data OR OLD.id <> NEW.id
BEGIN
  DELETE FROM current_receipt_links WHERE trip_id = OLD.id;
  INSERT INTO current_receipt_links (trip_id,entity_type,entity_id,expense_id,source_draft_id,receipt_id,has_expense_link)
  SELECT NEW.id,'expense',json_extract(entry.value,'$.id'),NULL,
  iif(json_type(entry.value,'$.sourceDraftId') = 'text',json_extract(entry.value,'$.sourceDraftId'),NULL),
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),0
FROM json_each(NEW.data,'$.expenses') entry WHERE json_type(entry.value,'$.id') = 'text'
UNION ALL
SELECT NEW.id,'draft',json_extract(entry.value,'$.id'),
  iif(json_type(entry.value,'$.expenseId') = 'text',json_extract(entry.value,'$.expenseId'),NULL),NULL,
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),
  json_extract(entry.value,'$.expenseId') IS NOT NULL
FROM json_each(NEW.data,'$.drafts') entry WHERE json_type(entry.value,'$.id') = 'text';
  UPDATE trips SET receipt_link_version = OLD.receipt_link_version + 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER current_receipt_links_delete AFTER DELETE ON trips
BEGIN DELETE FROM current_receipt_links WHERE trip_id = OLD.id; END;
--> statement-breakpoint
-- Historical snapshots are extracted once. Their small metadata rows retain
-- deleted and restored links without reparsing financial/message payloads.
CREATE TABLE receipt_history_links (
  trip_id text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  sequence integer NOT NULL, snapshot_order integer NOT NULL,
  expense_id text, source_draft_id text, receipt_id text,
  has_expense_link integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX receipt_history_links_snapshot_idx ON receipt_history_links (sequence,snapshot_order);
--> statement-breakpoint
CREATE INDEX receipt_history_links_entity_idx ON receipt_history_links (trip_id,entity_type,entity_id,sequence);
--> statement-breakpoint
CREATE INDEX receipt_history_links_expense_idx ON receipt_history_links (trip_id,entity_type,expense_id,entity_id);
--> statement-breakpoint
CREATE INDEX receipt_history_links_source_idx ON receipt_history_links (trip_id,entity_type,source_draft_id,entity_id);
--> statement-breakpoint
CREATE INDEX receipt_history_links_receipt_idx ON receipt_history_links (trip_id,entity_type,receipt_id,entity_id);
--> statement-breakpoint
CREATE TRIGGER receipt_history_links_insert AFTER INSERT ON activity_events WHEN NEW.entity_type IN ('expense','draft','receipt')
BEGIN
  INSERT INTO receipt_history_links (trip_id,entity_type,entity_id,sequence,snapshot_order,expense_id,source_draft_id,receipt_id,has_expense_link)
  SELECT NEW.trip_id,NEW.entity_type,NEW.entity_id,NEW.sequence,0,iif(json_type(NEW.before_data,'$.expenseId') = 'text',json_extract(NEW.before_data,'$.expenseId'),NULL),iif(json_type(NEW.before_data,'$.sourceDraftId') = 'text',json_extract(NEW.before_data,'$.sourceDraftId'),NULL),iif(json_type(NEW.before_data,'$.receiptId') = 'text',json_extract(NEW.before_data,'$.receiptId'),NULL),json_extract(NEW.before_data,'$.expenseId') IS NOT NULL WHERE NEW.entity_type IN ('expense','draft') AND NEW.before_data IS NOT NULL
  UNION ALL
  SELECT NEW.trip_id,NEW.entity_type,NEW.entity_id,NEW.sequence,1,iif(json_type(NEW.after_data,'$.expenseId') = 'text',json_extract(NEW.after_data,'$.expenseId'),NULL),iif(json_type(NEW.after_data,'$.sourceDraftId') = 'text',json_extract(NEW.after_data,'$.sourceDraftId'),NULL),iif(json_type(NEW.after_data,'$.receiptId') = 'text',json_extract(NEW.after_data,'$.receiptId'),NULL),json_extract(NEW.after_data,'$.expenseId') IS NOT NULL WHERE NEW.entity_type IN ('expense','draft') AND NEW.after_data IS NOT NULL;
  UPDATE trips SET receipt_link_version = receipt_link_version + 1 WHERE id = NEW.trip_id;
END;
--> statement-breakpoint
-- One-time backfill from existing accepted trip snapshots.
INSERT OR IGNORE INTO current_receipt_links (trip_id,entity_type,entity_id,expense_id,source_draft_id,receipt_id,has_expense_link)
SELECT t.id,'expense',json_extract(entry.value,'$.id'),NULL,
  iif(json_type(entry.value,'$.sourceDraftId') = 'text',json_extract(entry.value,'$.sourceDraftId'),NULL),
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),0
FROM trips t,json_each(t.data,'$.expenses') entry WHERE json_type(entry.value,'$.id') = 'text'
UNION ALL
SELECT t.id,'draft',json_extract(entry.value,'$.id'),
  iif(json_type(entry.value,'$.expenseId') = 'text',json_extract(entry.value,'$.expenseId'),NULL),NULL,
  iif(json_type(entry.value,'$.receiptId') = 'text',json_extract(entry.value,'$.receiptId'),NULL),
  json_extract(entry.value,'$.expenseId') IS NOT NULL
FROM trips t,json_each(t.data,'$.drafts') entry WHERE json_type(entry.value,'$.id') = 'text';
--> statement-breakpoint
INSERT OR IGNORE INTO receipt_history_links (trip_id,entity_type,entity_id,sequence,snapshot_order,expense_id,source_draft_id,receipt_id,has_expense_link)
SELECT trip_id,entity_type,entity_id,sequence,0,iif(json_type(before_data,'$.expenseId') = 'text',json_extract(before_data,'$.expenseId'),NULL),iif(json_type(before_data,'$.sourceDraftId') = 'text',json_extract(before_data,'$.sourceDraftId'),NULL),iif(json_type(before_data,'$.receiptId') = 'text',json_extract(before_data,'$.receiptId'),NULL),json_extract(before_data,'$.expenseId') IS NOT NULL FROM activity_events WHERE entity_type IN ('expense','draft') AND before_data IS NOT NULL
UNION ALL
SELECT trip_id,entity_type,entity_id,sequence,1,iif(json_type(after_data,'$.expenseId') = 'text',json_extract(after_data,'$.expenseId'),NULL),iif(json_type(after_data,'$.sourceDraftId') = 'text',json_extract(after_data,'$.sourceDraftId'),NULL),iif(json_type(after_data,'$.receiptId') = 'text',json_extract(after_data,'$.receiptId'),NULL),json_extract(after_data,'$.expenseId') IS NOT NULL FROM activity_events WHERE entity_type IN ('expense','draft') AND after_data IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER receipt_history_links_no_update BEFORE UPDATE ON receipt_history_links
BEGIN SELECT RAISE(ABORT,'Receipt history links are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_history_links_no_delete BEFORE DELETE ON receipt_history_links
BEGIN SELECT RAISE(ABORT,'Receipt history links are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_history_links_no_replace BEFORE INSERT ON receipt_history_links
WHEN EXISTS (SELECT 1 FROM receipt_history_links WHERE sequence = NEW.sequence AND snapshot_order = NEW.snapshot_order)
BEGIN SELECT RAISE(ABORT,'Receipt history links are immutable'); END;
