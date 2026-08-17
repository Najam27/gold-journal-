ALTER TABLE `gj_mt5_connections` ADD `lastHistoryAttempt` timestamp;--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `lastHistoryStatus` varchar(32);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `lastHistoryMessage` varchar(255);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `lastHistoryBatchSize` int;