CREATE TABLE `gj_notification_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`accountId` int,
	`type` varchar(60) NOT NULL,
	`message` text NOT NULL,
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gj_notification_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `gj_notification_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`goalAlerts` boolean NOT NULL DEFAULT true,
	`emailAlerts` boolean NOT NULL DEFAULT false,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gj_notification_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `gj_notification_settings_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `gj_option_lists` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`category` varchar(80) NOT NULL,
	`value` varchar(160) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gj_option_lists_id` PRIMARY KEY(`id`),
	CONSTRAINT `gj_option_list_unique` UNIQUE(`userId`,`category`,`value`)
);
--> statement-breakpoint
CREATE INDEX `gj_notification_owner_idx` ON `gj_notification_history` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `gj_option_list_owner_idx` ON `gj_option_lists` (`userId`);