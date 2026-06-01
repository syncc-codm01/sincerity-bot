const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

const FORM_CHANNEL_ID = '1509951821903302797';
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
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

client.once(Events.ClientReady, (c) => {
  console.log(`[Sincerity Bot] Logged in as ${c.user.tag}`);
  registerCommands(c.user.id);
  scheduleKickChecks();
});

client.on(Events.GuildMemberAdd, (member) => {
  if (member.roles.cache.has(ROLE_VERIFIED)) return;

  const data = loadData();
  if (!data[member.id]) {
    data[member.id] = Date.now();
    saveData(data);
    console.log(`[Join] Started 3-day verification timer for ${member.user.tag}`);
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

    const data = loadData();
    if (!data[mentionedUserId]) {
      data[mentionedUserId] = Date.now();
      console.log(`[Timer] Started 3-day kick timer for ${member.user.tag}`);
    } else {
      console.log(`[Timer] Timer already running for ${member.user.tag} (started on join)`);
    }
    saveData(data);
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
  delete data[newMember.id];
  saveData(data);
  console.log(`[Verified] Cancelled kick timer for ${newMember.user.tag}`);

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

  for (const [userId, timestamp] of entries) {
    const elapsed = now - timestamp;
    const remaining = KICK_AFTER_MS - elapsed;

    let label;
    if (remaining <= 0) {
      label = '⚠️ **Overdue** (pending kick)';
    } else {
      const hours = Math.floor(remaining / (1000 * 60 * 60));
      const days = Math.floor(hours / 24);
      const hrs = hours % 24;
      label = days > 0 ? `${days}d ${hrs}h remaining` : `${hrs}h remaining`;
    }

    let display = `<@${userId}>`;
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

async function checkAndKick() {
  const data = loadData();
  const now = Date.now();
  let changed = false;

  for (const [userId, timestamp] of Object.entries(data)) {
    const elapsed = now - timestamp;
    if (elapsed < KICK_AFTER_MS) continue;

    for (const [, guild] of client.guilds.cache) {
      let member;
      try {
        member = await guild.members.fetch(userId);
      } catch {
        delete data[userId];
        changed = true;
        continue;
      }

      if (member.roles.cache.has(ROLE_VERIFIED)) {
        delete data[userId];
        changed = true;
        console.log(`[Kick Check] ${member.user.tag} is verified — removing from tracker`);
        continue;
      }

      try {
        await member.kick('Did not complete verification within 3 days');
        console.log(`[Kick] Kicked ${member.user.tag} for not completing verification within 3 days`);
      } catch (err) {
        console.error(`[Error] Failed to kick ${member.user.tag}:`, err.message);
      }

      delete data[userId];
      changed = true;
    }
  }

  if (changed) saveData(data);
}

client.login(process.env.DISCORD_TOKEN);
