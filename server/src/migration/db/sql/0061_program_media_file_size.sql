ALTER TABLE `program_media_file` ADD `size_bytes` integer;
--> statement-breakpoint
-- Re-materialize existing Plex metadata once on its next normal scan.
UPDATE `program` SET `canonical_id` = NULL WHERE `source_type` = 'plex';
