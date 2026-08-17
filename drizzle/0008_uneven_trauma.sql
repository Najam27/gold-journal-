ALTER TABLE `gj_accounts` ADD `bootstrapKey` varchar(32);--> statement-breakpoint
ALTER TABLE `gj_accounts` ADD CONSTRAINT `gj_accounts_user_bootstrap_unique` UNIQUE(`userId`,`bootstrapKey`);