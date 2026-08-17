CREATE TABLE `gj_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(100) NOT NULL,
	`startingBalance` decimal(14,2) NOT NULL DEFAULT '0.00',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gj_cash_movements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`movementDate` timestamp NOT NULL,
	`type` enum('DEPOSIT','WITHDRAW') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gj_cash_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gj_daily_plans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`planDate` timestamp NOT NULL,
	`preBias` varchar(40) DEFAULT '',
	`keyLevels` text,
	`sessionFocus` json,
	`planNotes` text,
	`rulesPlanned` json,
	`emotionStart` text,
	`emotionEnd` text,
	`executionScore` int,
	`rulesFollowed` json,
	`whatWentWell` text,
	`whatWentWrong` text,
	`lessons` text,
	`overallRating` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_daily_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `gj_daily_plan_unique` UNIQUE(`userId`,`accountId`,`planDate`)
);
--> statement-breakpoint
CREATE TABLE `gj_goals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` text,
	`period` enum('DAILY','WEEKLY','MONTHLY') NOT NULL,
	`metric` varchar(80) NOT NULL,
	`comparison` enum('GTE','LTE') NOT NULL,
	`target` decimal(14,2) NOT NULL,
	`notify` boolean NOT NULL DEFAULT true,
	`active` boolean NOT NULL DEFAULT true,
	`isCustom` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_goals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gj_skipped_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`tradeDate` timestamp NOT NULL,
	`session` varchar(40) NOT NULL,
	`level` varchar(100) DEFAULT '',
	`timeframe` varchar(20) DEFAULT '',
	`direction` enum('BUY','SELL') NOT NULL,
	`skipReason` varchar(120) NOT NULL,
	`confidence` int NOT NULL,
	`outcome` varchar(80) NOT NULL,
	`estimatedMissed` decimal(14,2) NOT NULL DEFAULT '0.00',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gj_skipped_trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gj_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int NOT NULL,
	`tradeDate` timestamp NOT NULL,
	`session` varchar(40) NOT NULL,
	`direction` enum('BUY','SELL') NOT NULL,
	`result` enum('WIN','LOSS','BREAK_EVEN','OPEN') NOT NULL,
	`level` varchar(100) DEFAULT '',
	`timeframe` varchar(20) DEFAULT '',
	`setupQuality` varchar(40) DEFAULT '',
	`executionType` varchar(80) DEFAULT '',
	`marketCondition` varchar(40) DEFAULT '',
	`biasAlignment` varchar(40) DEFAULT '',
	`confirmationType` varchar(60) DEFAULT '',
	`slPlacement` varchar(60) DEFAULT '',
	`tpPlacement` varchar(60) DEFAULT '',
	`mistake` varchar(80) DEFAULT '',
	`holdQuality` varchar(60) DEFAULT '',
	`patienceScore` int,
	`risk` decimal(14,2),
	`reward` decimal(14,2),
	`pnl` decimal(14,2) NOT NULL DEFAULT '0.00',
	`notes` text,
	`emotionBefore` text,
	`emotionDuring` text,
	`emotionAfter` text,
	`screenshotKey` varchar(500),
	`screenshotName` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`)
);
--> statement-breakpoint
CREATE INDEX `gj_accounts_user_idx` ON `gj_accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `gj_cash_owner_account_idx` ON `gj_cash_movements` (`userId`,`accountId`);--> statement-breakpoint
CREATE INDEX `gj_daily_plan_owner_account_idx` ON `gj_daily_plans` (`userId`,`accountId`);--> statement-breakpoint
CREATE INDEX `gj_goals_owner_account_idx` ON `gj_goals` (`userId`,`accountId`);--> statement-breakpoint
CREATE INDEX `gj_skipped_owner_account_idx` ON `gj_skipped_trades` (`userId`,`accountId`);--> statement-breakpoint
CREATE INDEX `gj_trades_owner_account_date_idx` ON `gj_trades` (`userId`,`accountId`,`tradeDate`);