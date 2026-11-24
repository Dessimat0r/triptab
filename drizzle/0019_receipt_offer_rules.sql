CREATE TABLE `receipt_offer_rules` (
	`user_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`user_id`, `rule_key`),
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
