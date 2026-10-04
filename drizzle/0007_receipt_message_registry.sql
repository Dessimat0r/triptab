CREATE TABLE `receipt_messages` (
	`trip_id` text NOT NULL,
	`message_id` text NOT NULL,
	`message_data` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_messages_trip_message_idx` ON `receipt_messages` (`trip_id`,`message_id`);
--> statement-breakpoint
-- Pay the historical JSON extraction cost once, never for each fresh question.
-- Latest immutable snapshot wins; after-data wins within the same event.
WITH snapshots AS (
  SELECT trip_id,sequence,0 AS snapshot_order,before_data AS data FROM activity_events WHERE entity_type IN ('expense','draft')
  UNION ALL
  SELECT trip_id,sequence,1 AS snapshot_order,after_data AS data FROM activity_events WHERE entity_type IN ('expense','draft')
), messages AS (
  SELECT trip_id,json_extract(message.value,'$.id') AS message_id,message.value AS message_data,
    ROW_NUMBER() OVER (PARTITION BY trip_id,json_extract(message.value,'$.id') ORDER BY sequence DESC,snapshot_order DESC) AS position
  FROM snapshots,json_each(snapshots.data,'$.conversation') message
  WHERE json_type(message.value,'$.id') = 'text'
)
INSERT INTO receipt_messages (trip_id,message_id,message_data)
SELECT trip_id,message_id,iif(json_extract(message_data,'$.role') = 'assistant',
  json_remove(message_data,'$.authorMemberId','$.authorName'),message_data)
FROM messages WHERE position = 1;
--> statement-breakpoint
-- Live legacy messages may predate activity history. Keep unknown speakers unknown.
WITH live AS (
  SELECT t.id AS trip_id,json_extract(message.value,'$.id') AS message_id,message.value AS message_data,
    ROW_NUMBER() OVER (PARTITION BY t.id,json_extract(message.value,'$.id') ORDER BY entries.key,message.key) AS position
  FROM trips t,json_each(t.data,'$.expenses') entries,json_each(entries.value,'$.conversation') message
  WHERE json_type(message.value,'$.id') = 'text'
  UNION ALL
  SELECT t.id,json_extract(message.value,'$.id'),message.value,
    ROW_NUMBER() OVER (PARTITION BY t.id,json_extract(message.value,'$.id') ORDER BY entries.key,message.key)
  FROM trips t,json_each(t.data,'$.drafts') entries,json_each(entries.value,'$.conversation') message
  WHERE json_type(message.value,'$.id') = 'text'
), chosen AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY trip_id,message_id ORDER BY position,message_data) AS choice FROM live
)
INSERT INTO receipt_messages (trip_id,message_id,message_data)
SELECT trip_id,message_id,iif(json_extract(message_data,'$.role') = 'assistant',
  json_remove(message_data,'$.authorMemberId','$.authorName'),message_data)
FROM chosen WHERE choice = 1 AND NOT EXISTS (
  SELECT 1 FROM receipt_messages saved WHERE saved.trip_id = chosen.trip_id AND saved.message_id = chosen.message_id
);
--> statement-breakpoint
-- Projection updates share the history transaction, including legacy deletion before-images.
-- iif avoids CASE/END ambiguity in Wrangler's migration statement tokenizer.
CREATE TRIGGER receipt_messages_from_activity AFTER INSERT ON activity_events
WHEN NEW.entity_type IN ('expense','draft')
BEGIN
  INSERT INTO receipt_messages (trip_id,message_id,message_data)
  SELECT NEW.trip_id,json_extract(message.value,'$.id'),iif(json_extract(message.value,'$.role') = 'assistant',
    json_remove(message.value,'$.authorMemberId','$.authorName'),message.value)
  FROM json_each(NEW.after_data,'$.conversation') message
  WHERE json_type(message.value,'$.id') = 'text' AND NOT EXISTS (
    SELECT 1 FROM receipt_messages saved WHERE saved.trip_id = NEW.trip_id AND saved.message_id = json_extract(message.value,'$.id')
  );
  INSERT INTO receipt_messages (trip_id,message_id,message_data)
  SELECT NEW.trip_id,json_extract(message.value,'$.id'),iif(json_extract(message.value,'$.role') = 'assistant',
    json_remove(message.value,'$.authorMemberId','$.authorName'),message.value)
  FROM json_each(NEW.before_data,'$.conversation') message
  WHERE json_type(message.value,'$.id') = 'text' AND NOT EXISTS (
    SELECT 1 FROM receipt_messages saved WHERE saved.trip_id = NEW.trip_id AND saved.message_id = json_extract(message.value,'$.id')
  );
END;
--> statement-breakpoint
CREATE TRIGGER receipt_messages_no_update BEFORE UPDATE ON receipt_messages
BEGIN SELECT RAISE(ABORT,'Receipt message identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_messages_no_delete BEFORE DELETE ON receipt_messages
BEGIN SELECT RAISE(ABORT,'Receipt message identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_messages_no_replace BEFORE INSERT ON receipt_messages
WHEN EXISTS (SELECT 1 FROM receipt_messages WHERE trip_id = NEW.trip_id AND message_id = NEW.message_id)
BEGIN SELECT RAISE(ABORT,'Receipt message identity is immutable'); END;
