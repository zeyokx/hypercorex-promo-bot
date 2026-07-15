import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from "discord.js";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

const QUESTIONS = [
  "Why do you wanna be management?",
  "Why should we trust you?",
  "What makes you special?",
  "What first change will you make?",
  "What should you do if the owner makes a bad choice?",
];

interface TestSession {
  guildId: string;
  guildName: string;
  requesterId: string;
  requesterTag: string;
  userId: string;
  answers: string[];
  currentQuestion: number;
  dmChannelId: string;
}

const activeSessions = new Map<string, TestSession>();

async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_channel_config (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  logger.info("Migrations complete");
}

async function getTestChannel(guildId: string): Promise<string | null> {
  const res = await pool.query(
    "SELECT channel_id FROM test_channel_config WHERE guild_id = $1",
    [guildId],
  );
  return res.rows[0]?.channel_id ?? null;
}

async function setTestChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO test_channel_config (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
    [guildId, channelId],
  );
}

const testRequestCommand = new SlashCommandBuilder()
  .setName("testrequest")
  .setDescription("Send a management test to a user via DM")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((o) =>
    o.setName("user").setDescription("The user to test").setRequired(true),
  );

const channelSetTestCommand = new SlashCommandBuilder()
  .setName("channelsettest")
  .setDescription("Set the channel where completed test results are posted")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((o) =>
    o
      .setName("channel")
      .setDescription("The channel to receive test results")
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText),
  );

const allCommands = [testRequestCommand, channelSetTestCommand].map((c) =>
  c.toJSON(),
);

async function registerCommands(rest: REST, appId: string, guildId: string) {
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: allCommands,
  });
  logger.info({ guildId }, "Registered commands");
}

export async function startBot(): Promise<void> {
  await runMigrations();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: ["CHANNEL" as never],
  });

  client.once("clientReady", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Bot online");

    const rest = new REST().setToken(token!);

    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: [] });
      logger.info("Cleared all global commands");
    } catch (err) {
      logger.warn({ err }, "Could not clear global commands");
    }

    const guilds = await readyClient.guilds.fetch();
    for (const [guildId] of guilds) {
      try {
        await registerCommands(rest, readyClient.user.id, guildId);
      } catch (err) {
        logger.error({ err, guildId }, "Failed to register commands in guild");
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
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "testrequest")
          await handleTestRequest(interaction, client);
        else if (interaction.commandName === "channelsettest")
          await handleChannelSetTest(interaction);
      } else if (interaction.isButton()) {
        await handleButton(interaction as ButtonInteraction, client);
      }
    } catch (err) {
      logger.error({ err }, "Interaction error");
    }
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.channel.isDMBased()) return;
    const session = activeSessions.get(message.author.id);
    if (!session) return;
    await handleTestAnswer(message.author.id, message.content, client, session);
  });

  await client.login(token);
}

async function handleChannelSetTest(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  await setTestChannel(interaction.guildId!, channel.id);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Test Channel Set")
    .setDescription(`Completed test results will now be sent to <#${channel.id}>.`)
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleTestRequest(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const targetUser = interaction.options.getUser("user", true);

  if (targetUser.bot) {
    await interaction.reply({ content: "❌ You cannot test a bot.", flags: 64 });
    return;
  }

  if (activeSessions.has(targetUser.id)) {
    await interaction.reply({
      content: `❌ **${targetUser.tag}** already has an active test in progress.`,
      flags: 64,
    });
    return;
  }

  const channelId = await getTestChannel(interaction.guildId!);
  if (!channelId) {
    await interaction.reply({
      content:
        "❌ No test result channel set. Run `/channelsettest` first to configure where results are sent.",
      flags: 64,
    });
    return;
  }

  let dmChannel;
  try {
    dmChannel = await targetUser.createDM();
    const introEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📋 Management Test — Creator EXH")
      .setDescription(
        `You have been invited to take a management test by **${interaction.user.tag}** from **${interaction.guild!.name}**.\n\n` +
          `There are **${QUESTIONS.length} questions**. Answer each one in this DM.\n` +
          `Take your time — your answers matter.\n\n` +
          `**Starting now…**`,
      )
      .setTimestamp();

    await dmChannel.send({ embeds: [introEmbed] });
  } catch {
    await interaction.reply({
      content: `❌ Could not DM **${targetUser.tag}**. They may have DMs disabled.`,
      flags: 64,
    });
    return;
  }

  const session: TestSession = {
    guildId: interaction.guildId!,
    guildName: interaction.guild!.name,
    requesterId: interaction.user.id,
    requesterTag: interaction.user.tag,
    userId: targetUser.id,
    answers: [],
    currentQuestion: 0,
    dmChannelId: dmChannel.id,
  };
  activeSessions.set(targetUser.id, session);

  await sendQuestion(targetUser.id, client, session);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Test Sent")
    .setDescription(
      `A management test has been sent to **${targetUser.tag}** via DM.\nResults will appear in <#${channelId}> when they finish.`,
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: 64 });
}

async function sendQuestion(
  userId: string,
  client: Client,
  session: TestSession,
): Promise<void> {
  const q = QUESTIONS[session.currentQuestion];
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const dmChannel = await user.createDM().catch(() => null);
  if (!dmChannel) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Question ${session.currentQuestion + 1} / ${QUESTIONS.length}`)
    .setDescription(`**${q}**`)
    .setFooter({ text: "Type your answer in this DM" })
    .setTimestamp();

  await dmChannel.send({ embeds: [embed] });
}

async function handleTestAnswer(
  userId: string,
  answer: string,
  client: Client,
  session: TestSession,
): Promise<void> {
  session.answers.push(answer.slice(0, 1000));
  session.currentQuestion += 1;

  if (session.currentQuestion < QUESTIONS.length) {
    await sendQuestion(userId, client, session);
    return;
  }

  activeSessions.delete(userId);

  const user = await client.users.fetch(userId).catch(() => null);

  const dmChannel = await user?.createDM().catch(() => null);
  if (dmChannel) {
    const doneEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Test Complete!")
      .setDescription(
        "You have answered all the questions. Your responses have been submitted for review.\nYou will be notified of the decision.",
      )
      .setTimestamp();
    await dmChannel.send({ embeds: [doneEmbed] });
  }

  const channelId = await getTestChannel(session.guildId);
  if (!channelId) return;

  const guild = await client.guilds.fetch(session.guildId).catch(() => null);
  if (!guild) return;

  const resultChannel = (await guild.channels
    .fetch(channelId)
    .catch(() => null)) as TextChannel | null;
  if (!resultChannel) return;

  const answersText = QUESTIONS.map(
    (q, i) => `**Q${i + 1}: ${q}**\n${session.answers[i] ?? "*(no answer)*"}`,
  ).join("\n\n");

  const resultEmbed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("📋 Management Test Result")
    .setDescription(
      `**Applicant:** <@${userId}> (${user?.tag ?? userId})\n` +
        `**Requested by:** <@${session.requesterId}> (${session.requesterTag})\n\n` +
        answersText,
    )
    .setFooter({ text: "Creator EXH • Management Test" })
    .setTimestamp();

  const acceptBtn = new ButtonBuilder()
    .setCustomId(`test_accept:${userId}`)
    .setLabel("Accept")
    .setStyle(ButtonStyle.Success)
    .setEmoji("✅");

  const declineBtn = new ButtonBuilder()
    .setCustomId(`test_decline:${userId}`)
    .setLabel("Decline")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("❌");

  const ticketBtn = new ButtonBuilder()
    .setCustomId(`test_ticket:${userId}`)
    .setLabel("Create Ticket")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("🎫");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    acceptBtn,
    declineBtn,
    ticketBtn,
  );

  await resultChannel.send({ embeds: [resultEmbed], components: [row] });
}

async function handleButton(
  interaction: ButtonInteraction,
  client: Client,
): Promise<void> {
  const [action, targetUserId] = interaction.customId.split(":");
  if (!targetUserId) return;

  const targetUser = await client.users.fetch(targetUserId).catch(() => null);

  if (action === "test_accept") {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Accepted")
      .setDescription(
        `<@${targetUserId}> has been **accepted** by <@${interaction.user.id}>.`,
      )
      .setTimestamp();
    await interaction.update({ embeds: [interaction.message.embeds[0], embed], components: [] });

    if (targetUser) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle("🎉 Application Accepted!")
        .setDescription(
          `Congratulations! Your management application for **${interaction.guild?.name}** has been **accepted**.\nWelcome to the team!`,
        )
        .setTimestamp();
      await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
    }
  } else if (action === "test_decline") {
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("❌ Declined")
      .setDescription(
        `<@${targetUserId}> has been **declined** by <@${interaction.user.id}>.`,
      )
      .setTimestamp();
    await interaction.update({ embeds: [interaction.message.embeds[0], embed], components: [] });

    if (targetUser) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("Application Declined")
        .setDescription(
          `Your management application for **${interaction.guild?.name}** was not accepted at this time.\nThank you for applying.`,
        )
        .setTimestamp();
      await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
    }
  } else if (action === "test_ticket") {
    if (!interaction.guild) return;

    const existingChannel = interaction.guild.channels.cache.find(
      (c) => c.name === `ticket-${targetUserId}`,
    );
    if (existingChannel) {
      await interaction.reply({
        content: `❌ A ticket already exists: <#${existingChannel.id}>`,
        flags: 64,
      });
      return;
    }

    let ticketChannel: TextChannel;
    try {
      ticketChannel = (await interaction.guild.channels.create({
        name: `ticket-${targetUser?.username ?? targetUserId}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: targetUserId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      })) as TextChannel;
    } catch {
      await interaction.reply({
        content: "❌ Failed to create ticket channel. Make sure I have the **Manage Channels** permission.",
        flags: 64,
      });
      return;
    }

    const ticketEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎫 Management Ticket")
      .setDescription(
        `Hello <@${targetUserId}>! This ticket was created to discuss your management application.\n\n` +
          `<@${interaction.user.id}> will be with you shortly.`,
      )
      .setTimestamp();
    await ticketChannel.send({ content: `<@${targetUserId}> <@${interaction.user.id}>`, embeds: [ticketEmbed] });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎫 Ticket Created")
      .setDescription(
        `Ticket created for <@${targetUserId}>: <#${ticketChannel.id}>`,
      )
      .setTimestamp();
    await interaction.update({ embeds: [interaction.message.embeds[0], embed], components: [] });
  }
}
