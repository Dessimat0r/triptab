-- N05 (owner decision): an optional "Receipt ready notifications" setting.
-- It is off for every account, new and existing, so nobody receives an
-- alert they did not choose. A missing preferences row also means off; this
-- is deliberately unlike `scope`, whose missing-row default is 'all'.
-- The column is the only change: no existing row is rewritten and older code
-- ignores it, so rolling the code back past 0018 is schema-safe.
ALTER TABLE `notification_preferences` ADD `receipt_ready` integer DEFAULT 0 NOT NULL CHECK (`receipt_ready` IN (0,1));
