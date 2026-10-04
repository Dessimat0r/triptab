CREATE TABLE `activity_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`trip_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_data` text,
	`after_data` text,
	`revision` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_events_id_idx` ON `activity_events` (`id`);--> statement-breakpoint
CREATE INDEX `activity_events_trip_sequence_idx` ON `activity_events` (`trip_id`,`sequence`);
--> statement-breakpoint
CREATE TRIGGER `activity_events_no_update` BEFORE UPDATE ON `activity_events`
BEGIN
  SELECT RAISE(ABORT, 'Activity history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `activity_events_no_delete` BEFORE DELETE ON `activity_events`
BEGIN
  SELECT RAISE(ABORT, 'Activity history is append-only');
END;
