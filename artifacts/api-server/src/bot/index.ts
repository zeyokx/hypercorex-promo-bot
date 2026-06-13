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
} from "discord.js";
import { logger } from "../lib/logger";
import { db, pool, promotionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const token = process.env["DISCORD_BOT_TOKEN"];
const targetGuildId = process.env["DISCORD_GUILD_ID"];

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

const allCommands = [promoteCommand, demoteCommand, viewpromoCommand, rulesendCommand].map((c) =>
  c.toJSON(),
);

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
  logger.info("Database migrations complete");
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

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "promote") await handlePromote(interaction);
    if (interaction.commandName === "demote") await handleDemote(interaction);
    if (interaction.commandName === "viewpromo") await handleViewPromo(interaction);
    if (interaction.commandName === "rulesend") await handleRulesSend(interaction);
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

async function handleRulesSend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const channelOption = interaction.options.getChannel("channel");
  let target: TextChannel;

  if (channelOption) {
    if (channelOption.type !== ChannelType.GuildText) {
      await interaction.editReply("Please select a text channel.");
      return;
    }
    target = channelOption as TextChannel;
  } else {
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.editReply("This command can only be used in a text channel.");
      return;
    }
    target = interaction.channel as TextChannel;
  }

  const GOLD = 0xf5a623;
  const DARK = 0x23272a;

  const headerEmbed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("📋  ROBLOX UNCOPYLOCKED BY HYPERCORE X  |  SERVER RULES")
    .setDescription(
      "Welcome to the most trusted hub for Roblox development, open source assets, and uncopylocked resources.\n" +
      "By remaining in this server, you agree to abide by the directives outlined below.\n" +
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
    .setFooter({ text: "Roblox Uncopylocked by HyperCore X  •  Rules last updated" })
    .setTimestamp();

  await target.send({ embeds: [headerEmbed, conductEmbed, punishEmbed, footerEmbed] });
  await interaction.editReply(`✅ Rules posted in ${target}.`);
}
