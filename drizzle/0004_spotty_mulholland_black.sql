ALTER TABLE `gj_mt5_connections` ADD `mt5Login` bigint;--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `brokerServer` varchar(160);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `currency` varchar(16);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `balance` decimal(14,2);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `equity` decimal(14,2);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `margin` decimal(14,2);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `freeMargin` decimal(14,2);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `floatingPnl` decimal(14,2);--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `lastHistorySync` timestamp;--> statement-breakpoint
ALTER TABLE `gj_mt5_connections` ADD `historySyncedCount` int DEFAULT 0 NOT NULL;