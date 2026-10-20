CREATE TABLE `persona_identity_sheets` (
	`personaId` text NOT NULL,
	`style` text NOT NULL,
	`objectKey` text NOT NULL,
	`operationId` text NOT NULL,
	PRIMARY KEY(`personaId`, `style`)
);
