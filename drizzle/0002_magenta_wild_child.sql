ALTER TABLE `gj_daily_plans` ADD `marketContext` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `eventRisk` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `longScenario` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `shortScenario` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `noTradeCondition` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `invalidationLevel` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `riskLimit` varchar(40) DEFAULT '';--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `maxTrades` int;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `sizingPlan` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `executionNotes` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `planDeviation` text;--> statement-breakpoint
ALTER TABLE `gj_daily_plans` ADD `tomorrowFocus` text;