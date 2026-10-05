CREATE TABLE `chatgpt_plan_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`credentials` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`refresh_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chatgpt_plan_transactions` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_data` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chatgpt_plan_transactions_user_idx` ON `chatgpt_plan_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `chatgpt_plan_transactions_expiry_idx` ON `chatgpt_plan_transactions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `receipt_ai_settings` (
	`id` text PRIMARY KEY DEFAULT 'shared' NOT NULL,
	`user_id` text NOT NULL,
	`api_key_encrypted` text,
	`provider` text DEFAULT 'api' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "receipt_ai_settings_id_check" CHECK("receipt_ai_settings"."id" = 'shared'),
	CONSTRAINT "receipt_ai_settings_provider_check" CHECK("receipt_ai_settings"."provider" IN ('api','siwc'))
);
