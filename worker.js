require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require("discord.js");
const crypto = require("crypto");

const TOKEN = process.env.DISCORD_TOKEN;
const DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID;
const FEED_POLL_MS = Number(process.env.FEED_POLL_MS || 10000);
const NITRADO_API_BASE = (process.env.NITRADO_API_BASE || "https://api.nitrado.net").replace(/\/+$/, "");
const API_TIMEOUT = Number(process.env.NITRADO_API_TIMEOUT_MS || 12000);
const MASTER_KEY = process.env.RED_DAWN_MASTER_KEY || "";

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
});

// In-memory starter storage.
// For production, wire these records to DATABASE_URL so credentials survive restarts.
const guildState = new Map();

function getState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, {
      nitrado: null,
      feeds: {},
      channels: {},
      lastSnapshot: null
    });
  }
  return guildState.get(guildId);
}

function keyBytes() {
  if (!MASTER_KEY) return null;
  return crypto.createHash("sha256").update(MASTER_KEY).digest();
}

function encryptSecret(value) {
  const key = keyBytes();
  if (!key) throw new Error("RED_DAWN_MASTER_KEY is not configured.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value) {
  const key = keyBytes();
  if (!key) throw new Error("RED_DAWN_MASTER_KEY is not configured.");
  const [iv64, tag64, data64] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv64, "base64url"));
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data64, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function nitradoRequest(token, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
  try {
    const response = await fetch(`${NITRADO_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!response.ok) {
      const err = new Error(`Nitrado HTTP ${response.status}`);
      err.status = response.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function validateNitradoToken(token) {
  // Nitrado's services endpoint is used as a lightweight credential check.
  const result = await nitradoRequest(token, "/services");
  return result;
}

async function sendFeed(guild, feedName, title, description, color = 0x5865F2) {
  const state = getState(guild.id);
  const channelId = state.channels[feedName];
  if (!channelId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  return true;
}

const feedChannels = [
  ["SERVER FEEDS", [
    ["server-status", "Server status"],
    ["server-events", "Server events"],
    ["connections-feed", "Player connections"],
    ["server-errors", "Server errors"],
    ["restart-feed", "Restart notifications"]
  ]],
  ["PLAYER FEEDS", [
    ["player-feed", "Player feed"],
    ["join-leave-feed", "Join / leave"],
    ["kill-feed", "Kill feed"],
    ["player-reports", "Player reports"],
    ["player-activity", "Player activity"]
  ]],
  ["ADMIN", [
    ["admin-feed", "Admin feed"],
    ["admin-chat", "Admin chat"],
    ["moderation-log", "Moderation log"],
    ["staff-activity", "Staff activity"]
  ]],
  ["COMMUNITY", [
    ["announcements", "Announcements"],
    ["event-announcements", "Event announcements"],
    ["maintenance-announcements", "Maintenance announcements"]
  ]],
  ["LOGGING", [
    ["message-log", "Message log"],
    ["member-log", "Member log"],
    ["role-log", "Role log"],
    ["channel-log", "Channel log"],
    ["permission-log", "Permission log"],
    ["bot-log", "Bot log"]
  ]]
];

async function ensureStructure(guild) {
  const state = getState(guild.id);
  for (const [categoryName, channels] of feedChannels) {
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );
    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory
      });
    }

    for (const [name] of channels) {
      let channel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText &&
             c.parentId === category.id &&
             c.name === name
      );
      if (!channel) {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id
        });
      }
      state.channels[name] = channel.id;
    }
  }
  return state.channels;
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Create the Dawn Bot control/feed structure.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("nitrado")
    .setDescription("Manage the secure Nitrado connection.")
    .addSubcommand(s => s.setName("connect").setDescription("Enter a Nitrado token securely."))
    .addSubcommand(s => s.setName("status").setDescription("Check the Nitrado connection."))
    .addSubcommand(s => s.setName("disconnect").setDescription("Remove the saved Nitrado connection."))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("feeds")
    .setDescription("Manage Dawn Bot feeds.")
    .addSubcommand(s => s.setName("setup").setDescription("Create all feed channels."))
    .addSubcommand(s => s.setName("list").setDescription("Show configured feed channels."))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (DEV_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID || client.user.id, DEV_GUILD_ID), { body: commands });
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  }
}

client.once("ready", async () => {
  console.log(`Dawn Bot online as ${client.user.tag}`);
  await registerCommands().catch(err => console.error("Command registration failed:", err.message));
  console.log("Dawn Bot feed engine ready.");
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
      }

      if (interaction.commandName === "setup" || interaction.commandName === "feeds" && interaction.options.getSubcommand() === "setup") {
        await interaction.deferReply({ ephemeral: true });
        await ensureStructure(interaction.guild);
        await interaction.editReply("✅ Dawn Bot structure is ready. Trader feeds were not created.");
        return;
      }

      if (interaction.commandName === "feeds" && interaction.options.getSubcommand() === "list") {
        const state = getState(interaction.guild.id);
        const lines = Object.entries(state.channels).map(([k, v]) => `• \`${k}\` → <#${v}>`);
        await interaction.reply({
          content: lines.length ? lines.join("\n") : "No feed channels configured yet. Run `/feeds setup`.",
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === "nitrado") {
        const sub = interaction.options.getSubcommand();

        if (sub === "connect") {
          const modal = new ModalBuilder()
            .setCustomId("nitrado_token_modal")
            .setTitle("Dawn Bot • Nitrado");

          const input = new TextInputBuilder()
            .setCustomId("nitrado_token")
            .setLabel("Nitrado API token")
            .setPlaceholder("Paste your Nitrado token here")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(10);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
          return;
        }

        if (sub === "disconnect") {
          getState(interaction.guild.id).nitrado = null;
          await interaction.reply({ content: "🔐 Nitrado credentials removed from the active bot state.", ephemeral: true });
          return;
        }

        if (sub === "status") {
          const state = getState(interaction.guild.id);
          if (!state.nitrado) {
            await interaction.reply({ content: "Nitrado is not connected. Use `/nitrado connect`.", ephemeral: true });
            return;
          }
          await interaction.deferReply({ ephemeral: true });
          try {
            const token = decryptSecret(state.nitrado.encryptedToken);
            const data = await validateNitradoToken(token);
            const count = Array.isArray(data?.data?.services) ? data.data.services.length : null;
            await interaction.editReply(`🟢 Nitrado connection is working${count === null ? "." : ` • ${count} service(s) returned.`}`);
          } catch (e) {
            await interaction.editReply(`🔴 Nitrado connection failed: ${e.message}`);
          }
        }
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === "nitrado_token_modal") {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const token = interaction.fields.getTextInputValue("nitrado_token").trim();

      try {
        await validateNitradoToken(token);
        getState(interaction.guild.id).nitrado = {
          encryptedToken: encryptSecret(token),
          connectedAt: new Date().toISOString()
        };
        await interaction.editReply("🟢 Nitrado token verified and stored securely. The token was not posted into a Discord channel.");
        await sendFeed(interaction.guild, "bot-log", "Nitrado connected", "An administrator connected Dawn Bot to Nitrado.", 0x57F287);
      } catch (e) {
        await interaction.editReply(`🔴 Token validation failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong. Check the bot logs.", ephemeral: true }).catch(() => {});
    }
  }
});

// Discord-side logging foundation.
client.on("guildMemberAdd", member =>
  sendFeed(member.guild, "member-log", "Member joined", `${member.user.tag} joined the Discord.`, 0x57F287)
);
client.on("guildMemberRemove", member =>
  sendFeed(member.guild, "member-log", "Member left", `${member.user?.tag || member.id} left the Discord.`, 0xED4245)
);

client.login(TOKEN);
