CREATE TABLE `seeding_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`dataset` text NOT NULL,
	`revision` text NOT NULL,
	`selectedOn` text NOT NULL,
	`createdAt` integer NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	`budgetMicros` integer DEFAULT 0 NOT NULL,
	`reservedMicros` integer DEFAULT 0 NOT NULL,
	`requestId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seeding_runs_digest_unique` ON `seeding_runs` (`digest`);--> statement-breakpoint
CREATE TABLE `seeding_seeds` (
	`personaId` text PRIMARY KEY NOT NULL,
	`runId` text NOT NULL,
	`dataset` text NOT NULL,
	`uuid` text NOT NULL,
	`nameKey` text NOT NULL,
	`source` text NOT NULL,
	`ordinal` integer NOT NULL,
	`stage` text NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`retryStage` text,
	FOREIGN KEY (`runId`) REFERENCES `seeding_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seeding_seeds_nameKey_unique` ON `seeding_seeds` (`nameKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `seeding_source` ON `seeding_seeds` (`dataset`,`uuid`);--> statement-breakpoint
CREATE INDEX `seeding_pending` ON `seeding_seeds` (`pending`,`runId`,`ordinal`);--> statement-breakpoint
CREATE INDEX `seeding_run` ON `seeding_seeds` (`runId`,`ordinal`);
