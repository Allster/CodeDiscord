'use strict';
// /bug and /suggest. Both post into a bot-only channel with a discussion thread; staff set the status
// from a menu on the post, and the author gets a DM when it's fixed/implemented or denied.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, ThreadAutoArchiveDuration } = require('discord.js');
const { embed, isStaff, respond, clip, safeDM, COLORS, EPHEMERAL } = require('../lib/util');

const BUG_STATUS = {
  open: { label: 'Open', emoji: '🟠', color: 0xf0a020 },
  confirmed: { label: 'Confirmed', emoji: '🔴', color: COLORS.bad },
  progress: { label: 'Being fixed', emoji: '🛠️', color: COLORS.info },
  fixed: { label: 'Fixed', emoji: '✅', color: COLORS.ok, notify: true },
  wontfix: { label: 'Won\'t fix', emoji: '⚪', color: COLORS.muted, notify: true },
  duplicate: { label: 'Duplicate', emoji: '🔁', color: COLORS.muted },
  cantrepro: { label: 'Can\'t reproduce', emoji: '❔', color: COLORS.muted, notify: true },
};
const SUG_STATUS = {
  open: { label: 'Open for votes', emoji: '🗳️', color: COLORS.brand },
  considering: { label: 'Considering', emoji: '🤔', color: COLORS.warn },
  planned: { label: 'Planned', emoji: '📌', color: COLORS.info, notify: true },
  implemented: { label: 'Implemented', emoji: '✅', color: COLORS.ok, notify: true },
  denied: { label: 'Denied', emoji: '❌', color: COLORS.bad, notify: true },
};

const input = (id, label, style, { required = true, max, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};

function bugModal() {
  return new ModalBuilder().setCustomId('pc:bug:modal').setTitle('Report a bug').addComponents(
    input('title', 'Short summary', TextInputStyle.Short, { max: 100, placeholder: 'Shop button does nothing on mobile' }),
    input('steps', 'How do we make it happen?', TextInputStyle.Paragraph, { max: 1000, placeholder: '1. Join the game\n2. Open the shop\n3. Tap Buy' }),
    input('result', 'What happened vs what should happen', TextInputStyle.Paragraph, { max: 800 }),
    input('game', 'Which game? (and server/version if you know)', TextInputStyle.Short, { required: false, max: 100 }),
    input('device', 'Device (PC, mobile, console, tablet)', TextInputStyle.Short, { required: false, max: 60 }),
  );
}

function suggestModal() {
  return new ModalBuilder().setCustomId('pc:sug:modal').setTitle('Make a suggestion').addComponents(
    input('title', 'Your idea in one line', TextInputStyle.Short, { max: 100 }),
    input('details', 'Details: what and why?', TextInputStyle.Paragraph, { max: 1500 }),
    input('game', 'Which game is it for? (optional)', TextInputStyle.Short, { required: false, max: 100 }),
  );
}

function statusMenu(kind, num, map, current) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`pc:${kind}:status:${num}`).setPlaceholder('Staff: set status')
    .addOptions(Object.entries(map).map(([k, s]) => ({ label: s.label, value: k, emoji: s.emoji, default: k === current }))));
}

function voteRow(num, item) {
  const v = Object.values(item.votes || {});
  const up = v.filter((x) => x > 0).length; const down = v.filter((x) => x < 0).length;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pc:sug:vote:${num}:up`).setLabel(String(up)).setEmoji('👍').setStyle(ButtonStyle.Success).setDisabled(item.status !== 'open' && item.status !== 'considering'),
    new ButtonBuilder().setCustomId(`pc:sug:vote:${num}:down`).setLabel(String(down)).setEmoji('👎').setStyle(ButtonStyle.Danger).setDisabled(item.status !== 'open' && item.status !== 'considering'),
  );
}

function bugEmbed(num, b, user) {
  const s = BUG_STATUS[b.status];
  const e = embed(s.color).setTitle(`Bug #${num}: ${b.title}`).setAuthor({ name: user?.tag || 'Reporter', iconURL: user?.displayAvatarURL?.() })
    .addFields(
      { name: 'Steps', value: clip(b.steps, 1024) },
      { name: 'What happened', value: clip(b.result, 1024) },
      ...(b.game ? [{ name: 'Game', value: clip(b.game, 1024), inline: true }] : []),
      ...(b.device ? [{ name: 'Device', value: clip(b.device, 1024), inline: true }] : []),
      { name: 'Status', value: `${s.emoji} ${s.label}${b.note ? `\n${clip(b.note, 900)}` : ''}`, inline: false },
    ).setFooter({ text: `Reported by ${user?.tag || b.userId}` }).setTimestamp(b.at);
  return e;
}

function sugEmbed(num, sg, user) {
  const s = SUG_STATUS[sg.status];
  const v = Object.values(sg.votes || {});
  const score = v.reduce((a, b) => a + b, 0);
  return embed(s.color).setTitle(`Suggestion #${num}: ${sg.title}`).setAuthor({ name: user?.tag || 'Member', iconURL: user?.displayAvatarURL?.() })
    .setDescription(clip(sg.details, 3000))
    .addFields(
      ...(sg.game ? [{ name: 'Game', value: clip(sg.game, 1024), inline: true }] : []),
      { name: 'Score', value: `${score >= 0 ? '+' : ''}${score} (${v.length} vote${v.length === 1 ? '' : 's'})`, inline: true },
      { name: 'Status', value: `${s.emoji} ${s.label}${sg.note ? `\n${clip(sg.note, 900)}` : ''}`, inline: true },
    ).setTimestamp(sg.at);
}

async function postWithThread(guild, store, channelKey, payload, threadName) {
  const id = store.channelId(channelKey);
  const channel = id && (guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null));
  if (!channel) return null;
  const msg = await channel.send(payload);
  await msg.startThread({ name: threadName.slice(0, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }).catch(() => {});
  return msg;
}

async function handle(interaction, ctx) {
  const { store, config } = ctx;
  const [, kind, action, num, extra] = interaction.customId.split(':');
  const guild = interaction.guild;

  if (kind === 'bug' && action === 'modal') {
    await interaction.deferReply({ flags: EPHEMERAL });
    const b = { title: interaction.fields.getTextInputValue('title'), steps: interaction.fields.getTextInputValue('steps'), result: interaction.fields.getTextInputValue('result'), game: interaction.fields.getTextInputValue('game'), device: interaction.fields.getTextInputValue('device'), userId: interaction.user.id, status: 'open', at: Date.now() };
    const n = store.update((d) => ++d.bugs.counter);
    const msg = await postWithThread(guild, store, 'bugReports', { embeds: [bugEmbed(n, b, interaction.user)], components: [statusMenu('bug', n, BUG_STATUS, 'open')] }, `Bug #${n}: ${b.title}`);
    if (!msg) return interaction.editReply('The bug report channel isn\'t set up. Ask staff to run /setup.');
    store.update((d) => { d.bugs.reports[n] = { ...b, channelId: msg.channelId, messageId: msg.id }; });
    return interaction.editReply(`Thanks! Your report is **Bug #${n}**: ${msg.url}`);
  }

  if (kind === 'sug' && action === 'modal') {
    await interaction.deferReply({ flags: EPHEMERAL });
    const sg = { title: interaction.fields.getTextInputValue('title'), details: interaction.fields.getTextInputValue('details'), game: interaction.fields.getTextInputValue('game'), userId: interaction.user.id, status: 'open', votes: {}, at: Date.now() };
    const n = store.update((d) => ++d.suggestions.counter);
    const msg = await postWithThread(guild, store, 'suggestions', { embeds: [sugEmbed(n, sg, interaction.user)], components: [voteRow(n, sg), statusMenu('sug', n, SUG_STATUS, 'open')] }, `Suggestion #${n}: ${sg.title}`);
    if (!msg) return interaction.editReply('The suggestions channel isn\'t set up. Ask staff to run /setup.');
    store.update((d) => { d.suggestions.items[n] = { ...sg, channelId: msg.channelId, messageId: msg.id }; });
    return interaction.editReply(`Posted as **Suggestion #${n}**: ${msg.url}`);
  }

  if (kind === 'sug' && action === 'vote') {
    const sg = store.get('suggestions', 'items', num);
    if (!sg) return respond(interaction, 'I lost track of this suggestion.');
    if (sg.status !== 'open' && sg.status !== 'considering') return respond(interaction, 'Voting is closed on this one.');
    const val = extra === 'up' ? 1 : -1;
    store.update((d) => {
      const votes = d.suggestions.items[num].votes;
      if (votes[interaction.user.id] === val) delete votes[interaction.user.id]; else votes[interaction.user.id] = val;
    });
    const fresh = store.get('suggestions', 'items', num);
    const author = await interaction.client.users.fetch(fresh.userId).catch(() => null);
    return interaction.update({ embeds: [sugEmbed(num, fresh, author)], components: [voteRow(num, fresh), statusMenu('sug', num, SUG_STATUS, fresh.status)] });
  }

  if (action === 'status') {
    if (!isStaff(interaction.member, store, config)) return respond(interaction, 'Only staff can change the status.');
    const status = interaction.values[0];
    const isBug = kind === 'bug';
    const map = isBug ? BUG_STATUS : SUG_STATUS;
    const bucket = isBug ? 'bugs' : 'suggestions';
    const listKey = isBug ? 'reports' : 'items';
    const item = store.get(bucket, listKey, num);
    if (!item || !map[status]) return respond(interaction, 'I lost track of this one.');
    store.update((d) => { Object.assign(d[bucket][listKey][num], { status, statusBy: interaction.user.id, statusAt: Date.now() }); });
    const fresh = store.get(bucket, listKey, num);
    const author = await interaction.client.users.fetch(fresh.userId).catch(() => null);
    await interaction.update({
      embeds: [isBug ? bugEmbed(num, fresh, author) : sugEmbed(num, fresh, author)],
      components: isBug ? [statusMenu('bug', num, map, status)] : [voteRow(num, fresh), statusMenu('sug', num, map, status)],
    });
    const thread = interaction.message.thread;
    if (thread) await thread.send(`${map[status].emoji} ${interaction.user} set the status to **${map[status].label}**.`).catch(() => {});
    if (map[status].notify && author) await safeDM(author, `${map[status].emoji} Your ${isBug ? 'bug report' : 'suggestion'} **#${num}: ${fresh.title}** in **${guild.name}** is now **${map[status].label}**. ${interaction.message.url}`);
    return null;
  }
  return null;
}

// /bugnote and /suggestion note use this to add a staff note shown on the post.
async function setNote(guild, store, kind, num, note) {
  const isBug = kind === 'bug';
  const bucket = isBug ? 'bugs' : 'suggestions';
  const listKey = isBug ? 'reports' : 'items';
  const item = store.get(bucket, listKey, String(num));
  if (!item) return null;
  store.update((d) => { d[bucket][listKey][String(num)].note = note; });
  const fresh = store.get(bucket, listKey, String(num));
  const ch = guild.channels.cache.get(fresh.channelId);
  const msg = ch && await ch.messages.fetch(fresh.messageId).catch(() => null);
  if (!msg) return fresh;
  const author = await guild.client.users.fetch(fresh.userId).catch(() => null);
  await msg.edit({ embeds: [isBug ? bugEmbed(num, fresh, author) : sugEmbed(num, fresh, author)] });
  return fresh;
}

module.exports = { handle, bugModal, suggestModal, setNote, BUG_STATUS, SUG_STATUS };
