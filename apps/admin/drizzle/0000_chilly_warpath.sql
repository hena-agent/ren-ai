CREATE TABLE `persona_images` (
	`personaId` text NOT NULL,
	`objectKey` text NOT NULL,
	`style` text NOT NULL,
	`position` integer NOT NULL,
	`mimeType` text NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`personaId`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persona_image_position` ON `persona_images` (`personaId`,`style`,`position`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gender` text,
	`descriptionVersion` integer,
	`markdown` text NOT NULL,
	`timeZone` text NOT NULL,
	`language` text NOT NULL,
	`openingLine` text NOT NULL,
	`memoryInstruction` text NOT NULL,
	`published` integer NOT NULL,
	`state` text NOT NULL,
	`memory` text NOT NULL,
	`revision` integer NOT NULL,
	`commitId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
