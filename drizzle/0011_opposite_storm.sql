CREATE TABLE `trip_language_preferences` (
	`user_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `trip_id`),
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trip_language_preferences_trip_idx` ON `trip_language_preferences` (`trip_id`);
--> statement-breakpoint
PRAGMA optimize;
