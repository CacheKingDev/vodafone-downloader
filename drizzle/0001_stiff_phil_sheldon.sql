CREATE TABLE `storage_migration` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_target_id` integer NOT NULL,
	`to_target_id` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_documents` integer DEFAULT 0 NOT NULL,
	`migrated_documents` integer DEFAULT 0 NOT NULL,
	`failed_documents` integer DEFAULT 0 NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`error_message` text,
	FOREIGN KEY (`from_target_id`) REFERENCES `storage_target`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_target_id`) REFERENCES `storage_target`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `storage_target` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`backend` text NOT NULL,
	`purpose` text DEFAULT 'document' NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`config_enc` blob,
	`last_tested_at` integer,
	`last_test_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_target_name_unique` ON `storage_target` (`name`);