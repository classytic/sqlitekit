CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text,
	`status` text NOT NULL,
	`workerId` text,
	`lastHeartbeat` text,
	`retries` integer,
	`deletedAt` text,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_organizationId_idx` ON `runs` (`organizationId`);
--> statement-breakpoint
CREATE TABLE `versioned_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text,
	`status` text NOT NULL,
	`version` integer DEFAULT 0,
	`total` integer,
	`reads` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`leasedBy` text,
	`leaseExpiresAt` text,
	`createdAt` text NOT NULL
);
