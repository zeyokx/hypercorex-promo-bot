import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const whitelistTable = pgTable("whitelist", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  guildId: text("guild_id").notNull(),
  addedById: text("added_by_id").notNull(),
  addedByTag: text("added_by_tag").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Whitelist = typeof whitelistTable.$inferSelect;
