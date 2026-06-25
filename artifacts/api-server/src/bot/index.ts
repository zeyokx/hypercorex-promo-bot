import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  Role,
  TextChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { logger } from "../lib/logger";
import { db, pool, promotionsTable, whitelistTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const token = process.env["DISCORD_BOT_TOKEN"];
const targetGuildId = process.env["DISCORD_GUILD_ID"];
const ownerId = process.env["OWNER_ID"];

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}

function generatePromotionId(length = 10): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const promoteCommand = new SlashCommandBuilder()
  .setName("promote")
  .setDescription("Promote a staff member and assign them a new role")
  .addUserOption((o) =>
    o.setName("member").setDescription("The staff member to promote").setRequired(true),
  )
  .addRoleOption((o) =>
    o.setName("role").setDescription("The role to assign").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Reason for the promotion").setRequired(false),
  );

const demoteCommand = new SlashCommandBuilder()
  .setName("demote")
  .setDescription("Demote a staff member and remove their role")
  .addUserOption((o) =>
    o.setName("member").setDescription("The staff member to demote").setRequired(true),
  )
  .addRoleOption((o) =>
    o.setName("role").setDescription("The role to remove").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("reason").setDescription("Reason for the demotion").setRequired(false),
  );

const viewpromoCommand = new SlashCommandBuilder()
  .setName("viewpromo")
  .setDescription("View promotion/demotion history for a staff member")
  .addUserOption((o) =>
    o.setName("member").setDescription("The staff member to look up").setRequired(true),
  );

const rulesendCommand = new SlashCommandBuilder()
  .setName("rulesend")
  .setDescription("Post the server rules embeds")
  .addChannelOption((o) =>
    o.setName("channel").setDescription("Channel to send rules to (defaults to current)").setRequired(false),
  );

const announceCommand = new SlashCommandBuilder()
  .setName("announce")
  .setDescription("Send a styled announcement to a channel")
  .addStringOption((o) =>
    o.setName("message").setDescription("The announcement message").setRequired(true),
  )
  .addChannelOption((o) =>
    o.setName("channel").setDescription("Channel to post in (defaults to current)").setRequired(false),
  )
  .addStringOption((o) =>
    o.setName("title").setDescription("Announcement title (optional)").setRequired(false),
  );

const dropcodesCommand = new SlashCommandBuilder()
  .setName("dropcodes")
  .setDescription("Drop game codes with a styled embed")
  .addStringOption((o) =>
    o.setName("codes").setDescription("The codes to drop (one per line or comma-separated)").setRequired(true),
  )
  .addChannelOption((o) =>
    o.setName("channel").setDescription("Channel to post in (defaults to current)").setRequired(false),
  )
  .addStringOption((o) =>
    o.setName("game").setDescription("Game name (e.g. HyperCore X)").setRequired(false),
  );

const informationsendCommand = new SlashCommandBuilder()
  .setName("informationsend")
  .setDescription("Post the HyperCore X information & FAQ embeds")
  .addChannelOption((o) =>
    o.setName("channel").setDescription("Channel to post in (defaults to current)").setRequired(false),
  );

const sayCommand = new SlashCommandBuilder()
  .setName("say")
  .setDescription("Send a message publicly as the bot (with confirmation)")
  .addStringOption((o) =>
    o.setName("text").setDescription("The message to send").setRequired(true),
  )
  .addChannelOption((o) =>
    o.setName("channel").setDescription("Channel to send to (defaults to current)").setRequired(false),
  );

const whitelistCommand = new SlashCommandBuilder()
  .setName("whitelist")
  .setDescription("Manage who can use bot commands")
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a user to the whitelist")
      .addUserOption((o) =>
        o.setName("user").setDescription("User to whitelist").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a user from the whitelist")
      .addUserOption((o) =>
        o.setName("user").setDescription("User to remove").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List all whitelisted users"),
  );

const allCommands = [
  promoteCommand,
  demoteCommand,
  viewpromoCommand,
  rulesendCommand,
  announceCommand,
  dropcodesCommand,
  informationsendCommand,
  sayCommand,
  whitelistCommand,
].map((c) => c.toJSON());

async function registerCommands(rest: REST, appId: string, guildId: string) {
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: allCommands,
  });
  logger.info({ guildId }, "Registered commands in guild");
}

async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY,
      promotion_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_user_tag TEXT NOT NULL,
      role_id TEXT NOT NULL,
      role_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      signer_id TEXT NOT NULL,
      signer_tag TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whitelist (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      added_by_id TEXT NOT NULL,
      added_by_tag TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  logger.info("Database migrations complete");
}

async function isWhitelisted(userId: string, guildId: string): Promise<boolean> {
  if (ownerId && userId === ownerId) return true;
  const rows = await db
    .select()
    .from(whitelistTable)
    .where(and(eq(whitelistTable.userId, userId), eq(whitelistTable.guildId, guildId)))
    .limit(1);
  return rows.length > 0;
}

export async function startBot(): Promise<void> {
  await runMigrations();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once("ready", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is online");
    const rest = new REST().setToken(token!);

    const guilds = await readyClient.guilds.fetch();
    for (const [guildId] of guilds) {
      try {
        await registerCommands(rest, readyClient.user.id, guildId);
      } catch (err) {
        logger.error({ err, guildId }, "Failed to register commands in guild");
      }
    }

    if (guilds.size === 0) {
      logger.info("Bot is not in any guilds yet — invite it first, commands will register on join");
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

  client.on("error", (err) => {
    logger.error({ err }, "Discord client error");
  });

  const pendingSay = new Map<string, { text: string; channelId: string }>();

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        const pending = pendingSay.get(interaction.message.id);
        if (!pending) return;
        pendingSay.delete(interaction.message.id);

        if (interaction.customId === "say_confirm") {
          const guild = interaction.guild;
          if (!guild) { await interaction.update({ content: "❌ No guild found.", embeds: [], components: [] }); return; }
          const ch = await guild.channels.fetch(pending.channelId).catch(() => null);
          if (!ch || !ch.isTextBased()) { await interaction.update({ content: "❌ Channel not found.", embeds: [], components: [] }); return; }
          await (ch as TextChannel).send(pending.text);
          await interaction.update({ content: `✅ Message sent to <#${pending.channelId}>.`, embeds: [], components: [] });
        } else {
          await interaction.update({ content: "❌ Cancelled — message was not sent.", embeds: [], components: [] });
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      const allowed = await isWhitelisted(interaction.user.id, interaction.guildId ?? "");
      if (!allowed) {
        await interaction.reply({
          content: "🔒 You are not whitelisted to use bot commands.",
          flags: 64,
        });
        return;
      }

      if (interaction.commandName === "promote") await handlePromote(interaction);
      else if (interaction.commandName === "demote") await handleDemote(interaction);
      else if (interaction.commandName === "viewpromo") await handleViewPromo(interaction);
      else if (interaction.commandName === "rulesend") await handleRulesSend(interaction);
      else if (interaction.commandName === "announce") await handleAnnounce(interaction);
      else if (interaction.commandName === "dropcodes") await handleDropCodes(interaction);
      else if (interaction.commandName === "informationsend") await handleInformationSend(interaction);
      else if (interaction.commandName === "say") await handleSay(interaction, pendingSay);
      else if (interaction.commandName === "whitelist") await handleWhitelist(interaction);
    } catch (err) {
      logger.error({ err }, "Interaction handler error");
    }
  });

  await client.login(token);
}

async function handlePromote(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser("member", true);
  const role = interaction.options.getRole("role", true) as Role;
  const reason = interaction.options.getString("reason") ?? "No reason provided";
  const promotionId = generatePromotionId();
  const signer = interaction.user;

  if (!interaction.guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  let targetMember: GuildMember;
  try {
    targetMember = await interaction.guild.members.fetch(targetUser.id);
  } catch {
    await interaction.editReply("Could not find that member in this server.");
    return;
  }

  try {
    await targetMember.roles.add(role, `Promoted by ${signer.tag} | ID: ${promotionId}`);
  } catch {
    await interaction.editReply(
      "Failed to assign the role. Make sure the bot has **Manage Roles** permission and its role is above the target role.",
    );
    return;
  }

  await db.insert(promotionsTable).values({
    promotionId,
    type: "promotion",
    guildId: interaction.guild.id,
    targetUserId: targetUser.id,
    targetUserTag: targetUser.tag,
    roleId: role.id,
    roleName: role.name,
    reason,
    signerId: signer.id,
    signerTag: signer.tag,
  });

  const signerMember = await interaction.guild.members.fetch(signer.id).catch(() => null);
  const signerAvatar = signerMember?.displayAvatarURL() ?? signer.displayAvatarURL();
  const signerDisplayName = signerMember?.displayName ?? signer.username;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `Signed, ${signerDisplayName}`, iconURL: signerAvatar })
    .setTitle("Staff Promotion")
    .addFields(
      { name: "Staff Member", value: `${targetMember}`, inline: false },
      { name: "Role", value: `${role}`, inline: false },
      { name: "Reason", value: reason, inline: false },
    )
    .setFooter({ text: `Promotion ID | ${promotionId}` })
    .setThumbnail(targetMember.displayAvatarURL())
    .setColor(role.color || 0x57f287)
    .setTimestamp();

  await interaction.editReply({ content: `${targetMember}`, embeds: [embed] });
}

async function handleDemote(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser("member", true);
  const role = interaction.options.getRole("role", true) as Role;
  const reason = interaction.options.getString("reason") ?? "No reason provided";
  const demotionId = generatePromotionId();
  const signer = interaction.user;

  if (!interaction.guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  let targetMember: GuildMember;
  try {
    targetMember = await interaction.guild.members.fetch(targetUser.id);
  } catch {
    await interaction.editReply("Could not find that member in this server.");
    return;
  }

  try {
    await targetMember.roles.remove(role, `Demoted by ${signer.tag} | ID: ${demotionId}`);
  } catch {
    await interaction.editReply(
      "Failed to remove the role. Make sure the bot has **Manage Roles** permission and its role is above the target role.",
    );
    return;
  }

  await db.insert(promotionsTable).values({
    promotionId: demotionId,
    type: "demotion",
    guildId: interaction.guild.id,
    targetUserId: targetUser.id,
    targetUserTag: targetUser.tag,
    roleId: role.id,
    roleName: role.name,
    reason,
    signerId: signer.id,
    signerTag: signer.tag,
  });

  const signerMember = await interaction.guild.members.fetch(signer.id).catch(() => null);
  const signerAvatar = signerMember?.displayAvatarURL() ?? signer.displayAvatarURL();
  const signerDisplayName = signerMember?.displayName ?? signer.username;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `Signed, ${signerDisplayName}`, iconURL: signerAvatar })
    .setTitle("Staff Demotion")
    .addFields(
      { name: "Staff Member", value: `${targetMember}`, inline: false },
      { name: "Role Removed", value: `${role}`, inline: false },
      { name: "Reason", value: reason, inline: false },
    )
    .setFooter({ text: `Demotion ID | ${demotionId}` })
    .setThumbnail(targetMember.displayAvatarURL())
    .setColor(0xed4245)
    .setTimestamp();

  await interaction.editReply({ content: `${targetMember}`, embeds: [embed] });
}

async function handleViewPromo(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser("member", true);

  if (!interaction.guild) {
    await interaction.editReply("This command can only be used in a server.");
    return;
  }

  const records = await db
    .select()
    .from(promotionsTable)
    .where(
      and(
        eq(promotionsTable.targetUserId, targetUser.id),
        eq(promotionsTable.guildId, interaction.guild.id),
      ),
    )
    .orderBy(promotionsTable.createdAt);

  if (records.length === 0) {
    await interaction.editReply(`No promotion or demotion records found for ${targetUser}.`);
    return;
  }

  const lines = records.map((r) => {
    const emoji = r.type === "promotion" ? "🟢" : "🔴";
    const label = r.type === "promotion" ? "Promoted" : "Demoted";
    const date = new Date(r.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${emoji} **${label}** to/from **${r.roleName}** — *${r.reason}* — by <@${r.signerId}> on ${date}\n┗ ID: \`${r.promotionId}\``;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Staff History — ${targetUser.username}`)
    .setThumbnail(targetUser.displayAvatarURL())
    .setDescription(lines.join("\n\n"))
    .setColor(0x5865f2)
    .setFooter({ text: `${records.length} record${records.length !== 1 ? "s" : ""} total` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function resolveTextChannel(
  interaction: ChatInputCommandInteraction,
  optionName: string,
): Promise<TextChannel | null> {
  if (!interaction.guild) return null;
  const picked = interaction.options.getChannel(optionName);
  const targetId = picked ? picked.id : interaction.channelId;
  try {
    const ch = await interaction.guild.channels.fetch(targetId);
    if (!ch || !ch.isTextBased()) return null;
    return ch as TextChannel;
  } catch {
    return null;
  }
}

async function handleRulesSend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const target = await resolveTextChannel(interaction, "channel");
  if (!target) {
    await interaction.editReply("Could not resolve a text channel. Make sure I have access to it.");
    return;
  }

  const GOLD = 0xf5a623;
  const DARK = 0x23272a;

  const headerEmbed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("📋  HYPERCORE X  |  SERVER RULES")
    .setDescription(
      "Welcome to HyperCore X. By remaining in this server, you agree to abide by the directives outlined below.\n" +
      "**Ignorance of these rules is not an excusable offense.**",
    )
    .setTimestamp();

  const conductEmbed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("⚖️  SECTION I: CODE OF CONDUCT")
    .addFields(
      {
        name: "1.1  Mutual Respect",
        value:
          "Do not engage in harassment, toxicity, cyberbullying, or targeted hate speech.\n" +
          "Maintain a professional demeanour when interacting with developers and community members.",
        inline: false,
      },
      {
        name: "1.2  Safe For Work",
        value:
          "Your Discord status, nickname, avatar, and banner must remain Safe For Work at all times.",
        inline: false,
      },
      {
        name: "1.3  Language",
        value:
          "Keep conversations constructive. Excessive swearing disrupts the community environment.",
        inline: false,
      },
    );

  const punishEmbed = new EmbedBuilder()
    .setColor(DARK)
    .setTitle("🔨  SECTION II: PROHIBITED BEHAVIOUR & ESCALATIONS")
    .setDescription("The following actions carry automatic punishments outlined below.")
    .addFields(
      {
        name: "🔞  NSFW Content",
        value:
          "Posting, sharing, or linking any Not Safe For Work content of any kind.\n" +
          ">>> 🔴 **Permanent Ban** — no appeal.",
        inline: false,
      },
      {
        name: "📍  Doxxing",
        value:
          "Sharing or threatening to share the personal information of any member.\n" +
          ">>> 🔴 **Permanent Ban** — no appeal.",
        inline: false,
      },
      {
        name: "🤬  Excessive Swearing",
        value:
          "Repeated use of profane or offensive language directed at members or in public channels.\n" +
          ">>> ⚠️ Warning → 🔇 Mute → 👢 Kick → 🔨 Ban",
        inline: false,
      },
      {
        name: "📨  Spam",
        value:
          "Flooding channels with repeated messages, images, emotes, or unsolicited links.\n" +
          ">>> ⚠️ Warning → ⚠️ Warning 2 → 🔇 Mute",
        inline: false,
      },
      {
        name: "📣  Unsolicited Promotion",
        value:
          "Advertising servers, products, or services without explicit staff approval.\n" +
          ">>> ⚠️ Warning → 🔇 Mute → 👢 Kick",
        inline: false,
      },
    );

  const footerEmbed = new EmbedBuilder()
    .setColor(GOLD)
    .setDescription(
      "By participating in this server you confirm you have read and understood all rules above.\n" +
      "Staff decisions are final. For appeals contact a Senior Staff member directly.",
    )
    .setFooter({ text: "HyperCore X  •  Rules last updated" })
    .setTimestamp();

  const tosEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🔗  Discord Terms of Service")
    .setDescription(
      "All members must also comply with Discord's official Terms of Service and Community Guidelines.\n\n" +
      "📄 [Discord Terms of Service](https://discord.com/terms)\n" +
      "📋 [Discord Community Guidelines](https://discord.com/guidelines)",
    )
    .setFooter({ text: "HyperCore X  •  Violations may result in immediate removal" });

  await target.send({ embeds: [headerEmbed, conductEmbed, punishEmbed, tosEmbed, footerEmbed] });
  await interaction.editReply(`✅ Rules posted in ${target}.`);
}

async function handleInformationSend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const target = await resolveTextChannel(interaction, "channel");
  if (!target) {
    await interaction.editReply("Could not resolve a text channel. Make sure I have access to it.");
    return;
  }

  const CYAN = 0x00d4ff;
  const DARK = 0x23272a;
  const GOLD = 0xf5a623;

  const THUMBNAIL = "https://raw.githubusercontent.com/zeyokx/hypercorex-promo-bot/main/assets/game-thumbnail.png";

  const welcomeEmbed = new EmbedBuilder()
    .setColor(CYAN)
    .setTitle("⚡  Welcome to HyperCore X")
    .setDescription(
      "Your new home for competitive Roblox FPS action.\n" +
      "Read everything below to get started — this server has something for everyone.",
    )
    .setImage(THUMBNAIL)
    .setTimestamp();

  const aboutEmbed = new EmbedBuilder()
    .setColor(CYAN)
    .setTitle("🎮  About HyperCore X")
    .setDescription(
      "HyperCore X isn't your typical shooter game. In this fast-paced, competitive first-person shooter, " +
      "players fight in **1v1, 2v2, 3v3, 4v4, and 5v5 matches** using skill-based combat, slick weaponry, " +
      "and special abilities to outwit their opponents.\n\n" +
      "As you advance and move up the levels, you may develop new abilities, boost your health, and alter your playstyle. " +
      "HyperCore X is suitable for both recreational and competitive grinders — with a beginner-friendly tutorial, " +
      "group prizes, playtime rewards, fair growth, smooth animations, and simple gameplay.",
    );

  const faqEmbed = new EmbedBuilder()
    .setColor(DARK)
    .setTitle("❓  Frequently Asked Questions")
    .addFields(
      {
        name: "🤝  How do I apply for a Partnership?",
        value:
          "Open a ticket and ask for **Partnerships**.\n" +
          "Your server must have **at least 100 members** to be eligible.",
        inline: false,
      },
      {
        name: "🎟️  How do I claim a Code?",
        value:
          "Head to the **#codes** channel, find the latest code, then redeem it in-game.\n" +
          "It's quick and easy — just copy and paste!",
        inline: false,
      },
      {
        name: "🚨  How do I report a Hacker?",
        value:
          "DM a **Manager** directly, or open a **Hacker Ticket** in the support section.",
        inline: false,
      },
      {
        name: "🔓  How do I appeal a Ban?",
        value:
          "Open an **Appeals Ticket** and explain your situation.\n" +
          "⚠️ **Note:** Bans issued for exploiting are **not eligible** for appeal.",
        inline: false,
      },
    );

  const footerEmbed = new EmbedBuilder()
    .setColor(GOLD)
    .setDescription(
      "If your question isn't listed above, open a support ticket and our team will assist you.\n" +
      "We hope you enjoy your time in **HyperCore X** — good luck out there! ⚡",
    )
    .setFooter({ text: "HyperCore X  •  Information" })
    .setTimestamp();

  await target.send({ embeds: [welcomeEmbed, aboutEmbed, faqEmbed, footerEmbed] });
  await interaction.editReply(`✅ Information posted in ${target}.`);
}

async function handleAnnounce(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const target = await resolveTextChannel(interaction, "channel");
  if (!target) {
    await interaction.editReply("Could not resolve a text channel. Make sure I have access to it.");
    return;
  }

  const message = interaction.options.getString("message", true);
  const title = interaction.options.getString("title") ?? "📢  Announcement";
  const signer = interaction.user;
  const signerMember = interaction.guild
    ? await interaction.guild.members.fetch(signer.id).catch(() => null)
    : null;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(message)
    .setAuthor({
      name: signerMember?.displayName ?? signer.username,
      iconURL: signerMember?.displayAvatarURL() ?? signer.displayAvatarURL(),
    })
    .setFooter({ text: "HyperCore X" })
    .setTimestamp();

  await target.send({ content: "@everyone", embeds: [embed] });
  await interaction.editReply(`✅ Announcement sent to ${target}.`);
}

async function handleDropCodes(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const target = await resolveTextChannel(interaction, "channel");
  if (!target) {
    await interaction.editReply("Could not resolve a text channel. Make sure I have access to it.");
    return;
  }

  const codes = interaction.options.getString("codes", true);
  const game = interaction.options.getString("game") ?? "HyperCore X";

  const codeLines = codes
    .split(/[\n,]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `\`${c}\``)
    .join("\n");

  const TWITTER_BLUE = 0x1da1f2;
  const YOUTUBE_RED = 0xff0000;

  const twitterEmbed = new EmbedBuilder()
    .setColor(TWITTER_BLUE)
    .setAuthor({
      name: "Twitter / X",
      iconURL: "https://abs.twimg.com/icons/apple-touch-icon-192x192.png",
    })
    .setTitle(`🎮  CODES JUST DROPPED — ${game}`)
    .setDescription(
      `New codes are live! Redeem them in-game before they expire.\n\n${codeLines}`,
    )
    .setFooter({ text: "HyperCore X  •  Follow us on Twitter for the latest drops" })
    .setTimestamp();

  const youtubeEmbed = new EmbedBuilder()
    .setColor(YOUTUBE_RED)
    .setAuthor({
      name: "YouTube",
      iconURL: "https://www.gstatic.com/youtube/img/branding/favicon/favicon_144x144.png",
    })
    .setTitle("▶️  Watch the code reveal on YouTube")
    .setDescription(
      "Don't miss our latest video — code reveals, tutorials, and more!\n" +
      "🔔 **Subscribe and hit the bell** so you never miss a drop.",
    )
    .setFooter({ text: "HyperCore X  •  YouTube" })
    .setTimestamp();

  await target.send({ content: "@everyone", embeds: [twitterEmbed, youtubeEmbed] });
  await interaction.editReply(`✅ Codes dropped in ${target}.`);
}

async function handleSay(
  interaction: ChatInputCommandInteraction,
  pendingSay: Map<string, { text: string; channelId: string }>,
): Promise<void> {
  const text = interaction.options.getString("text", true);
  const channelOption = interaction.options.getChannel("channel");
  const targetId = channelOption ? channelOption.id : interaction.channelId;

  const confirm = new ButtonBuilder()
    .setCustomId("say_confirm")
    .setLabel("✅  Send it")
    .setStyle(ButtonStyle.Success);

  const cancel = new ButtonBuilder()
    .setCustomId("say_cancel")
    .setLabel("❌  Cancel")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);

  const preview = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📨  Preview — Are you sure?")
    .setDescription(`>>> ${text}`)
    .addFields({ name: "Sending to", value: `<#${targetId}>`, inline: true })
    .setFooter({ text: "Only you can see this — confirm or cancel below" });

  const reply = await interaction.reply({
    embeds: [preview],
    components: [row],
    flags: 64,
    withResponse: true,
  });

  const msgId = reply.resource?.message?.id;
  if (msgId) {
    pendingSay.set(msgId, { text, channelId: targetId });
    setTimeout(() => {
      if (pendingSay.has(msgId)) {
        pendingSay.delete(msgId);
        interaction.editReply({ content: "⏱️ Timed out — buttons expired.", embeds: [], components: [] }).catch(() => {});
      }
    }, 60_000);
  }
}

async function handleWhitelist(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId ?? "";

  if (sub === "add") {
    const target = interaction.options.getUser("user", true);
    const exists = await db
      .select()
      .from(whitelistTable)
      .where(and(eq(whitelistTable.userId, target.id), eq(whitelistTable.guildId, guildId)))
      .limit(1);

    if (exists.length > 0) {
      await interaction.reply({ content: `⚠️ ${target} is already whitelisted.`, flags: 64 });
      return;
    }

    await db.insert(whitelistTable).values({
      userId: target.id,
      guildId,
      addedById: interaction.user.id,
      addedByTag: interaction.user.tag,
    });

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Whitelisted")
      .setDescription(`${target} has been added to the whitelist and can now use bot commands.`)
      .addFields({ name: "Added by", value: `${interaction.user}`, inline: true })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  } else if (sub === "remove") {
    const target = interaction.options.getUser("user", true);

    if (ownerId && target.id === ownerId) {
      await interaction.reply({ content: "❌ You cannot remove the bot owner from the whitelist.", flags: 64 });
      return;
    }

    const deleted = await db
      .delete(whitelistTable)
      .where(and(eq(whitelistTable.userId, target.id), eq(whitelistTable.guildId, guildId)))
      .returning();

    if (deleted.length === 0) {
      await interaction.reply({ content: `⚠️ ${target} is not in the whitelist.`, flags: 64 });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("🚫 Removed from whitelist")
      .setDescription(`${target} has been removed and can no longer use bot commands.`)
      .addFields({ name: "Removed by", value: `${interaction.user}`, inline: true })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  } else {
    const rows = await db
      .select()
      .from(whitelistTable)
      .where(eq(whitelistTable.guildId, guildId));

    const lines = rows.map((r) => `<@${r.userId}>`).join("\n") || "No users whitelisted yet.";
    const ownerLine = ownerId ? `\n\n🔑 **Owner** (via env): <@${ownerId}>` : "";

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Whitelisted Users")
      .setDescription(lines + ownerLine)
      .setFooter({ text: `${rows.length} user${rows.length !== 1 ? "s" : ""} whitelisted` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
  }
}
