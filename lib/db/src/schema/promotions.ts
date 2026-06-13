import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const promotionsTable = pgTable("promotions", {
  id: serial("id").primaryKey(),
  promotionId: text("promotion_id").notNull().unique(),
  type: text("type").notNull(),
  guildId: text("guild_id").notNull(),
  targetUserId: text("target_user_id").notNull(),
  targetUserTag: text("target_user_tag").notNull(),
  roleId: text("role_id").notNull(),
  roleName: text("role_name").notNull(),
  reason: text("reason").notNull(),
  signerId: text("signer_id").notNull(),
  signerTag: text("signer_tag").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPromotionSchema = createInsertSchema(promotionsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertPromotion = z.infer<typeof insertPromotionSchema>;
export type Promotion = typeof promotionsTable.$inferSelect;
