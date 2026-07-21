PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_storage_migration` (
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
	FOREIGN KEY (`from_target_id`) REFERENCES `storage_target`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_target_id`) REFERENCES `storage_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_storage_migration`("id", "from_target_id", "to_target_id", "mode", "status", "total_documents", "migrated_documents", "failed_documents", "started_at", "finished_at", "error_message") SELECT "id", "from_target_id", "to_target_id", "mode", "status", "total_documents", "migrated_documents", "failed_documents", "started_at", "finished_at", "error_message" FROM `storage_migration`;--> statement-breakpoint
DROP TABLE `storage_migration`;--> statement-breakpoint
ALTER TABLE `__new_storage_migration` RENAME TO `storage_migration`;--> statement-breakpoint
PRAGMA foreign_keys=ON;