ALTER TABLE `receipts` ADD `legacy_cleanup_after` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Preserve unknown upload dates and grant historical images a fresh grace.
UPDATE `receipts`
SET `legacy_cleanup_after` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')
WHERE `state` = 'active' AND `created_at` = '' AND `legacy_cleanup_after` = '';--> statement-breakpoint
CREATE INDEX `receipts_legacy_cleanup_idx` ON `receipts` (`state`,`legacy_cleanup_after`);
