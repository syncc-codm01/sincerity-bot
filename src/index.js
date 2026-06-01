const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const FORM_CHANNEL_ID = '1509951821903302797';
const COUNTDOWN_CHANNEL_ID = '1510824786115297300';
const ROLE_CODM = '1510537801144467586';
const ROLE_TIKTOK = '1510537918333325382';
const ROLE_UNVERIFIED = '1510537467814740038';
const ROLE_VERIFIED = '1509947656149925948';

const DATA_FILE = path.join(__dirname, '..', 'data', 'unverified.json');
const KICK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return '⚠️ Overdue';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

function buildCountdownEmbed(member, joinedAt) {
  const remaining = KICK_AFTER_MS - (Date.now() - joinedAt);
  const kickTime = Math.floor((joinedAt + KICK_AFTER_MS) / 1000);
  const color = remaining < 24 * 60 * 60 * 1000 ? 0xFF0000 : 0xFFA500;

  return new EmbedBuilder()
    .setTitle('⏳ Pending Verification')
    .setDescription(
      `**${member.user.tag}** joined the server and has not yet been verified.\n\n` +
      `They will be automatically kicked <t:${kickTime}:R> if not verified.\n\n` +
      `**Time remaining:** ${formatTimeRemaining(remaining)}`
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setColor(color)
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show members currently in the unverified queue and their time remaining')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .toJSON(),
];

async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`[Commands] Slash commands registered for guild ${guildId}`);
    } catch (err) {
      console.error(`[Commands] Failed to register commands for guild ${guildId}:`, err.message);
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[Sincerity Bot] Logged in as ${c.user.tag}`);
  registerCommands(c.user.id);
  scheduleKickChecks();
  startCountdownUpdater();
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.roles.cache.has(ROLE_VERIFIED)) return;

  const data = loadData();
  if (data[member.id]) return;

  const joinedAt = Date.now();
  data[member.id] = { joinedAt, messageId: null };
  saveData(data);
  console.log(`[Join] Started verification timer for ${member.user.tag}`);

  try {
    await member.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('👋 Welcome to the server!')
          .setDescription(
            `Hey **${member.user.username}**! Welcome!\n\n` +
            `Please complete the verification form to gain access.\n\n` +
            `⚠️ **You will be automatically kicked in 3 days if you are not verified.**`
          )
          .setColor(0xFFA500)
          .setTimestamp()
      ]
    });
    console.log(`[DM] Sent welcome/warning DM to ${member.user.tag}`);
  } catch {
    console.log(`[DM] Could not DM ${member.user.tag} (DMs likely closed)`);
  }

  try {
    const channel = await client.channels.fetch(COUNTDOWN_CHANNEL_ID);
    const msg = await channel.send({ embeds: [buildCountdownEmbed(member, joinedAt)] });
    data[member.id].messageId = msg.id;
    saveData(data);
    console.log(`[Countdown] Posted countdown for ${member.user.tag}`);
  } catch (err) {
    console.error(`[Countdown] Failed to post countdown for ${member.user.tag}:`, err.message);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.channelId !== FORM_CHANNEL_ID) return;
  if (!message.author.bot) return;

  console.log(`[Form] Received bot message in form channel from ${message.author.tag}`);

  const content = message.content.toLowerCase();
  const embeds = message.embeds;

  let fullText = content;
  for (const embed of embeds) {
    if (embed.description) fullText += '\n' + embed.description.toLowerCase();
    for (const field of embed.fields || []) {
      fullText += '\n' + field.name.toLowerCase() + '\n' + field.value.toLowerCase();
    }
  }

  const mentionedUserId = extractMentionedUserId(message);
  if (!mentionedUserId) {
    console.log('[Form] Could not find a mentioned user in the form message. Skipping.');
    return;
  }

  const guild = message.guild;
  let member;
  try {
    member = await guild.members.fetch(mentionedUserId);
  } catch {
    console.log(`[Form] Could not fetch member ${mentionedUserId}`);
    return;
  }

  const rolesToAdd = [ROLE_UNVERIFIED];
  const saidYesToCodm = /codm[\s\S]{0,30}yes|yes[\s\S]{0,30}codm/i.test(fullText);
  const saidYesToTiktok = /tiktok[\s\S]{0,30}yes|yes[\s\S]{0,30}tiktok/i.test(fullText);

  if (saidYesToCodm) {
    rolesToAdd.push(ROLE_CODM);
    console.log(`[Form] ${member.user.tag} answered yes to CODM`);
  }
  if (saidYesToTiktok) {
    rolesToAdd.push(ROLE_TIKTOK);
    console.log(`[Form] ${member.user.tag} answered yes to TikTok`);
  }

  try {
    await member.roles.add(rolesToAdd, 'Form submission role assignment');
    console.log(`[Roles] Added roles to ${member.user.tag}: ${rolesToAdd.join(', ')}`);
  } catch (err) {
    console.error(`[Error] Failed to add roles to ${member.user.tag}:`, err.message);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const gainedVerified =
    !oldMember.roles.cache.has(ROLE_VERIFIED) &&
    newMember.roles.cache.has(ROLE_VERIFIED);

  if (!gainedVerified) return;

  const data = loadData();
  const entry = data[newMember.id];
  delete data[newMember.id];
  saveData(data);
  console.log(`[Verified] Cancelled kick timer for ${newMember.user.tag}`);

  if (entry?.messageId) {
    try {
      const channel = await client.channels.fetch(COUNTDOWN_CHANNEL_ID);
      const msg = await channel.messages.fetch(entry.messageId);
      await msg.delete();
      console.log(`[Countdown] Deleted countdown message for ${newMember.user.tag}`);
    } catch {
      console.log(`[Countdown] Could not delete countdown message for ${newMember.user.tag}`);
    }
  }

  if (newMember.roles.cache.has(ROLE_UNVERIFIED)) {
    try {
      await newMember.roles.remove(ROLE_UNVERIFIED, 'Member verified — removing unverified role');
      console.log(`[Verified] Removed unverified role from ${newMember.user.tag}`);
    } catch (err) {
      console.error(`[Error] Failed to remove unverified role from ${newMember.user.tag}:`, err.message);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'status') return;

  await interaction.deferReply({ ephemeral: true });

  const data = loadData();
  const now = Date.now();
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return interaction.editReply({ content: '✅ No members are currently in the unverified queue.' });
  }

  const guild = interaction.guild;
  const lines = [];

  for (const [userId, entry] of entries) {
    const joinedAt = entry?.joinedAt ?? entry;
    const remaining = KICK_AFTER_MS - (now - joinedAt);
    const kickTime = Math.floor((joinedAt + KICK_AFTER_MS) / 1000);

    const label = remaining <= 0
      ? '⚠️ **Overdue** (pending kick)'
      : `kicks <t:${kickTime}:R>`;

    let display;
    try {
      const member = await guild.members.fetch(userId);
      display = `**${member.user.tag}** (<@${userId}>)`;
    } catch {
      display = `Unknown user (<@${userId}>)`;
    }

    lines.push(`• ${display} — ${label}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔒 Unverified Queue')
    .setDescription(lines.join('\n'))
    .setColor(0xF04747)
    .setFooter({ text: `${entries.length} member${entries.length !== 1 ? 's' : ''} pending verification` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
});

function extractMentionedUserId(message) {
  if (message.mentions.users.size > 0) {
    return message.mentions.users.first().id;
  }

  const mentionMatch = message.content.match(/<@!?(\d+)>/);
  if (mentionMatch) return mentionMatch[1];

  for (const embed of message.embeds) {
    const embedText = (embed.description || '') + JSON.stringify(embed.fields || []);
    const embedMatch = embedText.match(/<@!?(\d+)>/) || embedText.match(/"(\d{17,19})"/);
    if (embedMatch) return embedMatch[1];
  }

  return null;
}

function scheduleKickChecks() {
  checkAndKick();
  setInterval(checkAndKick, 60 * 60 * 1000);
}

function startCountdownUpdater() {
  setInterval(updateCountdowns, 60 * 1000);
}

async function updateCountdowns() {
  const data = loadData();
  const entries = Object.entries(data);
  if (entries.length === 0) return;

  let channel;
  try {
    channel = await client.channels.fetch(COUNTDOWN_CHANNEL_ID);
  } catch {
    return;
  }

  for (const [userId, entry] of entries) {
    const joinedAt = entry?.joinedAt ?? entry;
    const messageId = entry?.messageId;
    if (!messageId) continue;

    for (const [, guild] of client.guilds.cache) {
      let member;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        continue;
      }

      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.edit({ embeds: [buildCountdownEmbed(member, joinedAt)] });
      } catch {
        console.log(`[Countdown] Could not update countdown for ${member.user.tag}`);
      }
    }
  }
}

async function checkAndKick() {
  const data = loadData();
  const now = Date.now();
  let changed = false;

  for (const [userId, entry] of Object.entries(data)) {
    const joinedAt = entry?.joinedAt ?? entry;
    const messageId = entry?.messageId;
    const elapsed = now - joinedAt;
    if (elapsed < KICK_AFTER_MS) continue;

    for (const [, guild] of client.guilds.cache) {
      let member;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        delete data[userId];
        changed = true;
        if (messageId) deleteCountdownMessage(messageId);
        continue;
      }

      if (member.roles.cache.has(ROLE_VERIFIED)) {
        delete data[userId];
        changed = true;
        console.log(`[Kick Check] ${member.user.tag} is verified — removing from tracker`);
        if (messageId) deleteCountdownMessage(messageId);
        continue;
      }

      try {
        await member.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ You have been kicked')
              .setDescription(
                `You were kicked from **${guild.name}** for not completing verification within the required time.\n\n` +
                `You are welcome to rejoin and complete the verification form.`
              )
              .setColor(0xFF0000)
              .setTimestamp()
          ]
        });
      } catch {
        console.log(`[DM] Could not send kick DM to ${member.user.tag}`);
      }

      try {
        await member.kick('Did not complete verification within the required time');
        console.log(`[Kick] Kicked ${member.user.tag}`);
      } catch (err) {
        console.error(`[Error] Failed to kick ${member.user.tag}:`, err.message);
      }

      if (messageId) deleteCountdownMessage(messageId);
      delete data[userId];
      changed = true;
    }
  }

  if (changed) saveData(data);
}

async function deleteCountdownMessage(messageId) {
  try {
    const channel = await client.channels.fetch(COUNTDOWN_CHANNEL_ID);
    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
  } catch {
  }
}

client.login(process.env.DISCORD_TOKEN);
