ALTER TABLE `channel` ADD `offset_source_channel_id` text REFERENCES channel(uuid) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `channel` ADD `offset_hours` integer;