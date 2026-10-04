-- Existing immutable snapshots populate these indexes once; later events keep
-- them current in the same transaction without rewriting historical rows.
CREATE INDEX `activity_events_trip_entity_idx` ON `activity_events` (`trip_id`,`entity_type`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `activity_events_draft_before_expense_idx` ON `activity_events` (`trip_id`,json_extract(before_data, '$.expenseId'),`entity_id`) WHERE entity_type = 'draft';--> statement-breakpoint
CREATE INDEX `activity_events_draft_after_expense_idx` ON `activity_events` (`trip_id`,json_extract(after_data, '$.expenseId'),`entity_id`) WHERE entity_type = 'draft';--> statement-breakpoint
CREATE INDEX `activity_events_expense_before_source_draft_idx` ON `activity_events` (`trip_id`,json_extract(before_data, '$.sourceDraftId'),`entity_id`) WHERE entity_type = 'expense';--> statement-breakpoint
CREATE INDEX `activity_events_expense_after_source_draft_idx` ON `activity_events` (`trip_id`,json_extract(after_data, '$.sourceDraftId'),`entity_id`) WHERE entity_type = 'expense';
