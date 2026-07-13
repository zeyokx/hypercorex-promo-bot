import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const vipClaimsTable = pgTable("vip_claims", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull().unique(),
  discordUserTag: text("discord_user_tag").notNull(),
  robloxUsername: text("roblox_username").notNull(),
  robloxUserId: text("roblox_user_id").notNull(),
  guildId: text("guild_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type VipClaim = typeof vipClaimsTable.$inferSelect;
