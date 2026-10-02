'use strict';
// Moderation: warn, timeout, kick, ban, purge, slowmode, lock. Every action gets a case number in #mod-log
// and (when possible) a DM to the member.
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { embed, isStaff, respond, parseDuration, formatDuration, safeDM, modLog, clip, ts, EPHEMERAL } = require('../lib/util');

const reasonOpt = (o) => o.setName('reason').setDescription('Why (the member sees this)').setMaxLength(400);

function canActOn(interaction, target) {
  if (!target) return 'That person isn\'t in the server.';
  if (target.id === interaction.user.id) return 'You can\'t do that to yourself.';
  if (target.id === interaction.client.user.id) return 'Nice try.';
  if (target.id === interaction.guild.ownerId) return 'You can\'t do that to the server owner.';
  const mine = interaction.member.roles.highest.position;
  if (interaction.user.id !== interaction.guild.ownerId && target.roles.highest.position >= mine) return 'Their highest role is the same as or above yours.';
  return null;
}

async function logCase(interaction, store, { action, color, target, reason, extra = [] }) {
  const n = store.update((d) => ++d.cases.counter);
  const user = target.user || target;
  await modLog(interaction.guild, store, {
    embeds: [embed(color).setTitle(`Case #${n} · ${action}`)
      .addFields(
        { name: 'Member', value: `${user} (${user.tag || user.username || user.id})`, inline: true },
        { name: 'Moderator', value: `${interaction.user}`, inline: true },
        ...extra.map(([name, value]) => ({ name, value, inline: true })),
        { name: 'Reason', value: clip(reason || 'No reason given', 1024) },
      ).setFooter({ text: `ID ${user.id}` }).setTimestamp()],
  });
  return n;
}

const dm = (user, guild, verb, reason, extra = '') => safeDM(user, { embeds: [embed('warn').setDescription(`You were **${verb}** in **${guild.name}**.${extra}\nReason: ${reason || 'No reason given'}`)] });

function staffGuard(interaction, ctx) {
  if (!isStaff(interaction.member, ctx.store, ctx.config)) { respond(interaction, 'Only staff can use this.'); return false; }
  return true;
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)).addStringOption((o) => reasonOpt(o).setRequired(true)),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const target = interaction.options.getMember('member');
      const why = canActOn(interaction, target); if (why) return respond(interaction, why);
      const reason = interaction.options.getString('reason', true);
      ctx.store.update((d) => { (d.warnings[target.id] ||= []).push({ reason, by: interaction.user.id, at: Date.now() }); });
      const total = ctx.store.get('warnings', target.id).length;
      const sent = await dm(target.user, interaction.guild, 'warned', reason);
      const n = await logCase(interaction, ctx.store, { action: 'Warn', color: 'warn', target, reason, extra: [['Total warnings', String(total)]] });
      return respond(interaction, `⚠️ Warned ${target} (case #${n}, ${total} total).${sent ? '' : ' Their DMs are closed, so they weren\'t told.'}`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('warnings').setDescription('See or clear a member\'s warnings').setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addBooleanOption((o) => o.setName('clear').setDescription('Clear all of their warnings')),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const user = interaction.options.getUser('member', true);
      const list = ctx.store.get('warnings', user.id) || [];
      if (interaction.options.getBoolean('clear')) {
        ctx.store.update((d) => { delete d.warnings[user.id]; });
        await logCase(interaction, ctx.store, { action: 'Warnings cleared', color: 'muted', target: user, reason: `${list.length} warning(s) cleared` });
        return respond(interaction, `Cleared ${list.length} warning(s) for ${user}.`);
      }
      if (!list.length) return respond(interaction, `${user} has no warnings.`);
      return respond(interaction, { embeds: [embed('warn').setTitle(`${user.tag}: ${list.length} warning(s)`).setDescription(clip(list.map((w, i) => `**${i + 1}.** ${w.reason} · <@${w.by}> ${ts(w.at, 'R')}`).join('\n'), 4000))], allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder().setName('timeout').setDescription('Time a member out').setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d (max 28d)').setRequired(true))
      .addStringOption(reasonOpt),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const target = interaction.options.getMember('member');
      const why = canActOn(interaction, target); if (why) return respond(interaction, why);
      const ms = parseDuration(interaction.options.getString('duration', true));
      if (!ms || ms > 28 * 86400e3) return respond(interaction, 'Duration should look like `10m`, `2h` or `3d`, up to 28 days.');
      if (!target.moderatable) return respond(interaction, 'I can\'t time them out. My role needs to be above theirs.');
      const reason = interaction.options.getString('reason') || '';
      await target.timeout(ms, `${interaction.user.tag}: ${reason || 'No reason'}`);
      await dm(target.user, interaction.guild, 'timed out', reason, ` Ends ${ts(Date.now() + ms, 'R')}.`);
      const n = await logCase(interaction, ctx.store, { action: 'Timeout', color: 'warn', target, reason, extra: [['Length', formatDuration(ms)]] });
      return respond(interaction, `🔇 Timed out ${target} for ${formatDuration(ms)} (case #${n}).`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('untimeout').setDescription('End a member\'s timeout').setDefaultMemberPermissions(P.ModerateMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)).addStringOption(reasonOpt),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const target = interaction.options.getMember('member');
      if (!target?.isCommunicationDisabled()) return respond(interaction, 'They aren\'t timed out.');
      if (!target.moderatable) return respond(interaction, 'My role needs to be above theirs.');
      const reason = interaction.options.getString('reason') || '';
      await target.timeout(null, `${interaction.user.tag}: ${reason || 'Timeout removed'}`);
      const n = await logCase(interaction, ctx.store, { action: 'Timeout removed', color: 'ok', target, reason });
      return respond(interaction, `🔊 Removed ${target}'s timeout (case #${n}).`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(P.KickMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)).addStringOption(reasonOpt),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const target = interaction.options.getMember('member');
      const why = canActOn(interaction, target); if (why) return respond(interaction, why);
      if (!target.kickable) return respond(interaction, 'I can\'t kick them. My role needs to be above theirs.');
      const reason = interaction.options.getString('reason') || '';
      await dm(target.user, interaction.guild, 'kicked', reason);
      await target.kick(`${interaction.user.tag}: ${reason || 'No reason'}`);
      const n = await logCase(interaction, ctx.store, { action: 'Kick', color: 'bad', target, reason });
      return respond(interaction, `👢 Kicked ${target.user.tag} (case #${n}).`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member (or anyone by ID)').setDefaultMemberPermissions(P.BanMembers).setDMPermission(false)
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addStringOption(reasonOpt)
      .addIntegerOption((o) => o.setName('delete_messages').setDescription('Delete their recent messages').addChoices({ name: 'None', value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last day', value: 86400 }, { name: 'Last 7 days', value: 604800 })),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const user = interaction.options.getUser('user', true);
      const target = interaction.options.getMember('user');
      if (target) { const why = canActOn(interaction, target); if (why) return respond(interaction, why); if (!target.bannable) return respond(interaction, 'I can\'t ban them. My role needs to be above theirs.'); }
      const reason = interaction.options.getString('reason') || '';
      if (target) await dm(user, interaction.guild, 'banned', reason);
      await interaction.guild.members.ban(user.id, { reason: `${interaction.user.tag}: ${reason || 'No reason'}`, deleteMessageSeconds: interaction.options.getInteger('delete_messages') || 0 });
      const n = await logCase(interaction, ctx.store, { action: 'Ban', color: 'bad', target: user, reason });
      return respond(interaction, `🔨 Banned ${user.tag} (case #${n}).`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('unban').setDescription('Unban someone by user ID').setDefaultMemberPermissions(P.BanMembers).setDMPermission(false)
      .addStringOption((o) => o.setName('user_id').setDescription('Their Discord user ID').setRequired(true)).addStringOption(reasonOpt),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const id = interaction.options.getString('user_id', true).replace(/\D/g, '');
      const reason = interaction.options.getString('reason') || '';
      const ban = await interaction.guild.bans.fetch(id).catch(() => null);
      if (!ban) return respond(interaction, 'That ID isn\'t banned.');
      await interaction.guild.members.unban(id, `${interaction.user.tag}: ${reason || 'Unbanned'}`);
      const n = await logCase(interaction, ctx.store, { action: 'Unban', color: 'ok', target: ban.user, reason });
      return respond(interaction, `Unbanned ${ban.user.tag} (case #${n}).`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('purge').setDescription('Bulk delete recent messages in this channel').setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((o) => o.setName('from').setDescription('Only messages from this person')),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      await interaction.deferReply({ flags: EPHEMERAL });
      const amount = interaction.options.getInteger('amount', true);
      const from = interaction.options.getUser('from');
      const fetched = await interaction.channel.messages.fetch({ limit: 100 });
      const twoWeeks = Date.now() - 14 * 86400e3 + 60e3;
      const pick = [...fetched.values()].filter((m) => (!from || m.author.id === from.id) && m.createdTimestamp > twoWeeks && !m.pinned).slice(0, amount);
      const deleted = pick.length ? await interaction.channel.bulkDelete(pick, true) : new Map();
      await modLog(interaction.guild, ctx.store, { embeds: [embed('muted').setDescription(`🧹 ${interaction.user} purged ${deleted.size} message(s) in ${interaction.channel}${from ? ` from ${from}` : ''}.`).setTimestamp()] });
      return interaction.editReply(`Deleted ${deleted.size} message(s).${deleted.size < amount ? ' (Messages older than 14 days and pinned messages are skipped.)' : ''}`);
    },
  },
  {
    data: new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode for this channel').setDefaultMemberPermissions(P.ManageChannels).setDMPermission(false)
      .addStringOption((o) => o.setName('delay').setDescription('e.g. 5s, 30s, 2m, or 0 to turn off').setRequired(true)),
    async execute(interaction, ctx) {
      if (!staffGuard(interaction, ctx)) return null;
      const raw = interaction.options.getString('delay', true).trim();
      const secs = raw === '0' || raw === 'off' ? 0 : Math.round((/^\d+$/.test(raw) ? Number(raw) * 1000 : parseDuration(raw) || -1) / 1000);
      if (secs < 0 || secs > 21600) return respond(interaction, 'Use something like `5s`, `30s`, `2m` (up to 6h), or `0` to turn it off.');
      await interaction.channel.setRateLimitPerUser(secs, interaction.user.tag);
      return respond(interaction, secs ? `🐢 Slowmode set to ${secs}s.` : 'Slowmode off.');
    },
  },
  {
    data: new SlashCommandBuilder().setName('lock').setDescription('Stop members from talking in this channel').setDefaultMemberPermissions(P.ManageChannels).setDMPermission(false)
      .addStringOption(reasonOpt),
    async execute(interaction, ctx) { return lockToggle(interaction, ctx, true); },
  },
  {
    data: new SlashCommandBuilder().setName('unlock').setDescription('Let members talk in this channel again').setDefaultMemberPermissions(P.ManageChannels).setDMPermission(false),
    async execute(interaction, ctx) { return lockToggle(interaction, ctx, false); },
  },
];

// Lock by denying Send Messages on @everyone and the member roles; unlock clears just that deny.
async function lockToggle(interaction, ctx, lock) {
  if (!staffGuard(interaction, ctx)) return null;
  const ch = interaction.channel;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) return respond(interaction, 'Use this in a text channel.');
  const keys = ['verified', 'creator', 'scripter', 'builder', 'modeler', 'ui', 'animator', 'audio', 'tester'];
  const ids = [interaction.guild.roles.everyone.id, ...keys.map((k) => ctx.store.roleId(k)).filter(Boolean)];
  for (const id of ids) {
    // Only touch roles that already have an overwrite here (plus @everyone), so we don't add access to anyone.
    if (id !== interaction.guild.roles.everyone.id && !ch.permissionOverwrites.cache.has(id)) continue;
    await ch.permissionOverwrites.edit(id, { SendMessages: lock ? false : null, SendMessagesInThreads: lock ? false : null }, { reason: `${lock ? 'Locked' : 'Unlocked'} by ${interaction.user.tag}` }).catch(() => {});
  }
  const reason = interaction.options.getString?.('reason') || '';
  await ch.send({ embeds: [embed(lock ? 'bad' : 'ok').setDescription(lock ? `🔒 This channel is locked.${reason ? ` ${reason}` : ''}` : '🔓 This channel is unlocked.')] }).catch(() => {});
  await modLog(interaction.guild, ctx.store, { embeds: [embed('muted').setDescription(`${lock ? '🔒' : '🔓'} ${interaction.user} ${lock ? 'locked' : 'unlocked'} ${ch}${reason ? `: ${reason}` : ''}`).setTimestamp()] });
  return respond(interaction, lock ? 'Locked.' : 'Unlocked.');
}

module.exports = { commands, canActOn };
