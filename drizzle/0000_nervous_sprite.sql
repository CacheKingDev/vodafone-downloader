CREATE TABLE `account` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`username_enc` blob NOT NULL,
	`password_enc` blob NOT NULL,
	`customer_urn` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`backfill_from` text,
	`session_state_enc` blob,
	`session_refreshed_at` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`status_detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_customer_urn_unique` ON `account` (`customer_urn`);--> statement-breakpoint
CREATE TABLE `admin_session` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoice` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`number` text NOT NULL,
	`issued_on` text NOT NULL,
	`due_on` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`subject` text,
	`contract_number` text,
	`discovered_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_account_number_unique` ON `invoice` (`account_id`,`number`);--> statement-breakpoint
CREATE TABLE `invoice_document` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`remote_document_id` text NOT NULL,
	`sub_type` text,
	`category` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`relative_path` text,
	`sha256` text,
	`size_bytes` integer,
	`stored_at` integer,
	`last_error` text,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoice`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_document_unique` ON `invoice_document` (`invoice_id`,`remote_document_id`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`trigger` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`invoices_seen` integer DEFAULT 0 NOT NULL,
	`documents_stored` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`artifact_path` text,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
