CREATE TABLE `notification_digests` (
	`user_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`updates` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `trip_id`),
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`delivery` text DEFAULT 'immediate' NOT NULL,
	`reminders` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_preferences_scope_check" CHECK("notification_preferences"."scope" IN ('all','involved','none')),
	CONSTRAINT "notification_preferences_delivery_check" CHECK("notification_preferences"."delivery" IN ('immediate','daily','none')),
	CONSTRAINT "notification_preferences_reminders_check" CHECK("notification_preferences"."reminders" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `receipt_restore_holds` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`until` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `receipt_restore_holds_until_idx` ON `receipt_restore_holds` (`until`);--> statement-breakpoint
CREATE TABLE `settlement_reminders` (
	`trip_id` text NOT NULL,
	`from_member` text NOT NULL,
	`to_member` text NOT NULL,
	`sent_at` text NOT NULL,
	`marker` text NOT NULL,
	PRIMARY KEY(`trip_id`, `from_member`, `to_member`),
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `user_agent` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_id_idx` ON `auth_sessions` (`session_id`) WHERE "auth_sessions"."session_id" <> '';--> statement-breakpoint
ALTER TABLE `profiles` ADD `deleted_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `ui_language` text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
UPDATE auth_sessions SET session_id=lower(hex(randomblob(16))) WHERE session_id='';
--> statement-breakpoint
-- Private history erasure is limited to an already deleted account.
DROP TRIGGER account_activity_events_no_delete;
--> statement-breakpoint
CREATE TRIGGER account_activity_events_no_delete BEFORE DELETE ON account_activity_events
WHEN NOT EXISTS(SELECT 1 FROM profiles WHERE id=OLD.user_id AND deleted_at<>'')
BEGIN SELECT RAISE(ABORT, 'Account history is append-only'); END;
