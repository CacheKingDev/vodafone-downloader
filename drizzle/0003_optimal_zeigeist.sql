CREATE TABLE `invoice_document_export` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`storage_target_id` integer NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`attempted_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `invoice_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`storage_target_id`) REFERENCES `storage_target`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_document_export_unique` ON `invoice_document_export` (`document_id`,`storage_target_id`);