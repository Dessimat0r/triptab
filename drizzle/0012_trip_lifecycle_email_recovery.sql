CREATE TABLE `auth_email_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`email` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_email_tokens_purpose_check" CHECK("auth_email_tokens"."purpose" IN ('verify','reset'))
);
--> statement-breakpoint
CREATE INDEX `auth_email_tokens_user_idx` ON `auth_email_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `auth_email_tokens_expiry_idx` ON `auth_email_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `receipt_object_purges` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `receipt_object_purges_created_idx` ON `receipt_object_purges` (`created_at`);--> statement-breakpoint
CREATE TABLE `trip_archives` (
	`user_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`archived_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `trip_id`),
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_archives_trip_idx` ON `trip_archives` (`trip_id`);--> statement-breakpoint
ALTER TABLE `auth_credentials` ADD `email_verified_at` text;