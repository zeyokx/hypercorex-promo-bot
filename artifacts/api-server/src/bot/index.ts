import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { db, pool, vipClaimsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const token = process.env["DISCORD_BOT_TOKEN"];
const GAMEPASS_ID = "1640971769";
const GAMEPASS_URL = `https://www.roblox.com/game-pass/${GAMEPASS_ID}/500`;
const AVATAR_URL =
  "https://raw.githubusercontent.com/zeyokx/hypercorex-promo-bot/main/assets/avatar.png";

if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

const buyCommand = new SlashCommandBuilder()
  .setName("buy")
  .setDescription("Purchase access")
  .addSubcommand((sub) =>
    sub
      .setName("vip")
      .setDescription("Claim your VIP role by verifying your Roblox gamepass ownership")
      .addStringOption((o) =>
        o
          .setName("roblox_username")
          .setDescription("Your exact Roblox username")
          .setRequired(true),
      ),
  );

const allCommands = [buyCommand].map((c) => c.toJSON());

async function registerCommands(rest: REST, appId: string, guildId: string) {
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: allCommands,
  });
  logger.info({ guildId }, "Registered commands");
}

async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vip_claims (
      id SERIAL PRIMARY KEY,
      discord_user_id TEXT NOT NULL UNIQUE,
      discord_user_tag TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      roblox_user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  logger.info("Migrations complete");
}

export async function startBot(): Promise<void> {
  await runMigrations();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once("ready", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Bot online");

    try {
      const avatarRes = await fetch(AVATAR_URL, { signal: AbortSignal.timeout(10_000) });
      const avatarBuffer = Buffer.from(await avatarRes.arrayBuffer());
      await readyClient.user.edit({ username: "Creator EXH", avatar: avatarBuffer });
      logger.info("Bot profile updated to Creator EXH");
    } catch (err) {
      logger.warn({ err }, "Could not update bot profile — skipping");
    }

    const rest = new REST().setToken(token!);
    const guilds = await readyClient.guilds.fetch();
    for (const [guildId] of guilds) {
      try {
        await registerCommands(rest, readyClient.user.id, guildId);
      } catch (err) {
        logger.error({ err, guildId }, "Failed to register commands");
      }
    }
  });

  client.on("guildCreate", async (guild) => {
    const rest = new REST().setToken(token!);
    try {
      await registerCommands(rest, client.user!.id, guild.id);
    } catch (err) {
      logger.error({ err }, "Failed to register commands in new guild");
    }
  });

  client.on("error", (err) => logger.error({ err }, "Discord client error"));

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "buy") await handleBuyVip(interaction);
    } catch (err) {
      logger.error({ err }, "Command error");
    }
  });

  await client.login(token);
}

async function handleBuyVip(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.options.getSubcommand() !== "vip") return;

  const robloxUsername = interaction.options.getString("roblox_username", true).trim();
  await interaction.deferReply({ flags: 64 });

  const existing = await db
    .select()
    .from(vipClaimsTable)
    .where(eq(vipClaimsTable.discordUserId, interaction.user.id))
    .limit(1);

  if (existing.length > 0) {
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("❌ Already Claimed")
      .setDescription(
        `You already claimed VIP with Roblox account **${existing[0].robloxUsername}**.\n\nEach Discord account can only claim VIP once.`,
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  let robloxUserId: number;
  try {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json()) as { data: { id: number; name: string }[] };
    if (!data.data?.[0]) {
      await interaction.editReply({
        content: `❌ Roblox user **${robloxUsername}** was not found. Double-check your username and try again.`,
      });
      return;
    }
    robloxUserId = data.data[0].id;
  } catch {
    await interaction.editReply({
      content: "❌ Could not reach Roblox servers. Please try again in a moment.",
    });
    return;
  }

  let ownsGamepass = false;
  try {
    const res = await fetch(
      `https://inventory.roblox.com/v1/users/${robloxUserId}/items/GamePass/${GAMEPASS_ID}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const data = (await res.json()) as { data: unknown[] };
    ownsGamepass = Array.isArray(data.data) && data.data.length > 0;
  } catch {
    await interaction.editReply({
      content: "❌ Could not check your Roblox inventory. Make sure your inventory is **public** on Roblox, then try again.",
    });
    return;
  }

  if (!ownsGamepass) {
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle("🛒 Gamepass Not Owned")
      .setDescription(
        `Your Roblox account **${robloxUsername}** does not own the VIP gamepass yet.\n\n**👉 Purchase it here:**\n${GAMEPASS_URL}\n\nAfter buying, run \`/buy vip\` again.\n\n> Make sure your Roblox inventory is set to **Public** so we can verify ownership.`,
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await db.insert(vipClaimsTable).values({
    discordUserId: interaction.user.id,
    discordUserTag: interaction.user.tag,
    robloxUsername,
    robloxUserId: String(robloxUserId),
    guildId: interaction.guildId ?? "",
  });

  const vipRoleId = process.env["VIP_ROLE_ID"];
  if (vipRoleId && interaction.guild) {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (member) await member.roles.add(vipRoleId).catch(() => {});
  }

  let avatarUrl: string | undefined;
  try {
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const thumbData = (await thumbRes.json()) as { data: { imageUrl: string }[] };
    avatarUrl = thumbData.data?.[0]?.imageUrl;
  } catch {}

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("🌟 VIP Activated!")
    .setDescription(
      `Welcome to VIP, ${interaction.user}!\n\nYour Roblox account **${robloxUsername}** has been verified.\nYour VIP access is now active — enjoy!`,
    )
    .setFooter({ text: "Creator EXH • VIP" })
    .setTimestamp();

  if (avatarUrl) embed.setThumbnail(avatarUrl);

  await interaction.editReply({ embeds: [embed] });
}
