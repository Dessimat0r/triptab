ALTER TABLE `receipts` ADD `created_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `receipts` ADD `state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX `receipts_owner_idx` ON `receipts` (`owner`);--> statement-breakpoint
CREATE INDEX `receipts_cleanup_idx` ON `receipts` (`state`,`created_at`);