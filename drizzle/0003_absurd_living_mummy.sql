CREATE TABLE `gj_mt5_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`apiKey` varchar(96) NOT NULL,
	`label` varchar(120) NOT NULL DEFAULT 'MT5 Connection',
	`active` boolean NOT NULL DEFAULT true,
	`lastPing` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_mt5_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `gj_mt5_connections_apiKey_unique` UNIQUE(`apiKey`),
	CONSTRAINT `gj_mt5_connection_account_unique` UNIQUE(`accountId`)
);
--> statement-breakpoint
CREATE TABLE `gj_mt5_live_positions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`accountId` int NOT NULL,
	`ticket` bigint NOT NULL,
	`symbol` varchar(32) NOT NULL,
	`direction` enum('BUY','SELL') NOT NULL,
	`lots` decimal(14,2) NOT NULL,
	`openPrice` decimal(18,6) NOT NULL,
	`closePrice` decimal(18,6),
	`slPrice` decimal(18,6),
	`tpPrice` decimal(18,6),
	`riskUsd` decimal(14,2) NOT NULL DEFAULT '0.00',
	`rewardUsd` decimal(14,2) NOT NULL DEFAULT '0.00',
	`rrRatio` decimal(14,2) NOT NULL DEFAULT '0.00',
	`floatingPnl` decimal(14,2) NOT NULL DEFAULT '0.00',
	`realizedPnl` decimal(14,2),
	`result` enum('WIN','LOSS','BREAK_EVEN'),
	`openTime` timestamp NOT NULL,
	`closeTime` timestamp,
	`status` enum('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_mt5_live_positions_id` PRIMARY KEY(`id`),
	CONSTRAINT `gj_mt5_live_account_ticket_unique` UNIQUE(`accountId`,`ticket`)
);
--> statement-breakpoint
ALTER TABLE `gj_trades` ADD `mt5Ticket` bigint;--> statement-breakpoint
ALTER TABLE `gj_trades` ADD CONSTRAINT `gj_trades_mt5_ticket_unique` UNIQUE(`accountId`,`mt5Ticket`);--> statement-breakpoint
CREATE INDEX `gj_mt5_connection_owner_idx` ON `gj_mt5_connections` (`userId`,`accountId`);--> statement-breakpoint
CREATE INDEX `gj_mt5_live_account_status_idx` ON `gj_mt5_live_positions` (`accountId`,`status`,`updatedAt`);