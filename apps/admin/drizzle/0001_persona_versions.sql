CREATE TABLE `persona_versions` (
  `personaId` text NOT NULL REFERENCES `personas`(`id`) ON DELETE cascade,
  `version` integer NOT NULL,
  `markdown` text NOT NULL,
  `createdAt` integer NOT NULL,
  `restoredFrom` integer,
  PRIMARY KEY (`personaId`, `version`)
);
--> statement-breakpoint
INSERT INTO `persona_versions` (`personaId`, `version`, `markdown`, `createdAt`, `restoredFrom`)
  SELECT `id`, 1, `markdown`, `updatedAt`, NULL FROM `personas`;
--> statement-breakpoint
ALTER TABLE `personas` ADD `currentVersion` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `personas` DROP COLUMN `markdown`;
