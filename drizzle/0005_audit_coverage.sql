CREATE TABLE `account_activity_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_data` text,
	`after_data` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_activity_events_id_idx` ON `account_activity_events` (`id`);--> statement-breakpoint
CREATE INDEX `account_activity_events_user_sequence_idx` ON `account_activity_events` (`user_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `invites` ADD `audit_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `receipts` ADD `content_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `receipts` ADD `size_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `receipts` ADD `sha256` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `invites` SET `audit_id` = lower(hex(randomblob(16))) WHERE `audit_id` = '';
--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `generation` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE `push_subscriptions` SET `generation` = lower(hex(randomblob(16))) WHERE `generation` = '';
--> statement-breakpoint
CREATE TRIGGER `activity_events_no_replace` BEFORE INSERT ON `activity_events`
WHEN EXISTS (SELECT 1 FROM `activity_events` WHERE `id` = NEW.id OR `sequence` = NEW.sequence)
BEGIN
  SELECT RAISE(ABORT, 'Activity history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `account_activity_events_no_update` BEFORE UPDATE ON `account_activity_events`
BEGIN
  SELECT RAISE(ABORT, 'Account history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `account_activity_events_no_delete` BEFORE DELETE ON `account_activity_events`
BEGIN
  SELECT RAISE(ABORT, 'Account history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `account_activity_events_no_replace` BEFORE INSERT ON `account_activity_events`
WHEN EXISTS (SELECT 1 FROM `account_activity_events` WHERE `id` = NEW.id OR `sequence` = NEW.sequence)
BEGIN
  SELECT RAISE(ABORT, 'Account history is append-only');
END;
