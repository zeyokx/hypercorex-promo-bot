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
} from "discord.js";
import { logger } from "../lib/logger";
import { db, promotionsTable } from "@workspace/db";
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

const allCommands = [promoteCommand, demoteCommand, viewpromoCommand].map((c) =>
  c.toJSON(),
);

async function registerCommands(rest: REST, appId: string, guildId: string) {
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: allCommands,
  });
  logger.info({ guildId }, "Registered commands in guild");
}

export async function startBot(): Promise<void> {
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
