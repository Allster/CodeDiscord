'use strict';
// Private ticket channels: support, player reports, team applications and business enquiries.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits: P, OverwriteType, AttachmentBuilder } = require('discord.js');
const { embed, isStaff, modLog, sendTo, respond, clip, EPHEMERAL } = require('../lib/util');

const short = (id, label, opts = {}) => ({ id, label, style: TextInputStyle.Short, ...opts });
const long = (id, label, opts = {}) => ({ id, label, style: TextInputStyle.Paragraph, ...opts });

const TICKET_TYPES = {
  support: { label: 'Get help', emoji: '🎫', blurb: 'Questions, account help or anything else.', fields: [short('subject', 'What do you need help with?', { max: 100 }), long('details', 'Details', { max: 1500 })] },
  report: { label: 'Report a player', emoji: '🚩', blurb: 'Report someone in the game or this server.', fields: [short('who', 'Who? (Roblox or Discord username)', { max: 100 }), long('what', 'What happened?', { max: 1500 }), short('evidence', 'Evidence links (screenshots/clips)', { required: false, max: 400 })] },
  apply: { label: 'Join the team', emoji: '💼', blurb: 'Apply as a scripter, builder, modeler, UI designer, animator, audio or tester.', staffChannel: 'applications', fields: [short('role', 'Which role? (e.g. Scripter, Builder)', { max: 60 }), short('roblox', 'Roblox username', { max: 20 }), short('portfolio', 'Portfolio link (DevForum, Talent Hub, etc.)', { max: 300 }), long('experience', 'Your experience and what you\'ve made', { max: 1200 }), short('availability', 'Hours per week / time zone', { max: 100 })] },
  business: { label: 'Business', emoji: '🤝', blurb: 'Partnerships, sponsorships and commissions.', fields: [short('who', 'Your name / company', { max: 100 }), long('details', 'What would you like to talk about?', { max: 1500 })] },
};

const STAFF_ROLE_KEYS = ['owner', 'lead', 'moderator'];
const USER_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks, P.AddReactions];

function openTicketOf(store, userId) {
  return Object.entries(store.get('tickets', 'open')).find(([, t]) => t.userId === userId)?.[0] || null;
}

function controls(claimedBy) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pc:ticket:claim').setLabel(claimedBy ? 'Claimed' : 'Claim').setStyle(ButtonStyle.Secondary).setEmoji('🙋').setDisabled(!!claimedBy),
    new ButtonBuilder().setCustomId('pc:ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
}

async function createTicket(interaction, { store }, type, answers) {
  const guild = interaction.guild;
  const t = TICKET_TYPES[type];
  const parentId = store.get('setup', 'categories', 'catTickets');
  const parent = parentId && guild.channels.cache.get(parentId);
  const number = store.update((d) => ++d.tickets.counter);
  const me = guild.members.me;
  const staffRoles = STAFF_ROLE_KEYS.map((k) => store.roleId(k)).filter(Boolean);
  const name = `${type === 'apply' ? 'apply' : type === 'report' ? 'report' : 'ticket'}-${String(number).padStart(4, '0')}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);

  const channel = await guild.channels.create({
    name, type: ChannelType.GuildText, parent: parent?.id,
    topic: `${t.label} ticket #${number} for ${interaction.user.tag} (${interaction.user.id})`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: interaction.user.id, allow: USER_ALLOW, type: OverwriteType.Member },
      { id: me.id, allow: [...USER_ALLOW, P.ManageChannels, P.ManageMessages], type: OverwriteType.Member },
      ...staffRoles.map((id) => ({ id, allow: [...USER_ALLOW, P.ManageMessages] })),
    ],
    reason: `Ticket #${number}`,
  });
  store.update((d) => { d.tickets.open[channel.id] = { number, type, userId: interaction.user.id, openedAt: Date.now(), claimedBy: null }; });

  const fields = t.fields.map((f) => ({ name: f.label, value: clip(answers[f.id] || '—', 1024) }));
  const summary = embed('info').setTitle(`${t.emoji} ${t.label} · #${number}`).setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() }).addFields(fields).setTimestamp();
  const pingRole = store.roleId(type === 'apply' ? 'lead' : 'moderator');
  await channel.send({
    content: `${interaction.user} thanks for reaching out, the team will be with you soon.${pingRole ? ` <@&${pingRole}>` : ''}`,
    embeds: [summary], components: [controls(null)],
    allowedMentions: { users: [interaction.user.id], roles: pingRole ? [pingRole] : [] },
  });
  if (t.staffChannel) await sendTo(guild, store, t.staffChannel, { content: `New application in ${channel}`, embeds: [summary] });
  await modLog(guild, store, { embeds: [embed('info').setDescription(`🎫 ${interaction.user} opened ${t.label.toLowerCase()} ticket #${number}: ${channel}`).setTimestamp()] });
  return channel;
}

async function transcript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 10; i++) { // up to 1,000 messages
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  const lines = all.reverse().map((m) => {
    const parts = [m.content];
    m.embeds.forEach((e) => parts.push(`[embed] ${e.title || ''} ${e.description || ''} ${(e.fields || []).map((f) => `${f.name}: ${f.value}`).join(' | ')}`.trim()));
    m.attachments.forEach((a) => parts.push(`[file] ${a.url}`));
    return `[${m.createdAt.toISOString()}] ${m.author.tag}: ${parts.filter(Boolean).join(' ')}`;
  });
  return { buffer: Buffer.from(lines.join('\n') || '(no messages)', 'utf8'), name: `${channel.name}.txt` };
}

async function closeTicket(channel, closer, { store }, reason = '') {
  const t = store.get('tickets', 'open', channel.id);
  if (!t) return false;
  const tr = await transcript(channel);
  const file = () => new AttachmentBuilder(tr.buffer, { name: tr.name });
  const opener = await channel.client.users.fetch(t.userId).catch(() => null);
  await modLog(channel.guild, store, {
    embeds: [embed('muted').setTitle(`Ticket #${t.number} closed`).setDescription(`Opened by <@${t.userId}> · closed by ${closer}${t.claimedBy ? ` · handled by <@${t.claimedBy}>` : ''}${reason ? `\nReason: ${reason}` : ''}`).setTimestamp()],
    files: [file()],
  });
  if (opener) await opener.send({ content: `Your ticket #${t.number} in **${channel.guild.name}** was closed.${reason ? ` Reason: ${reason}` : ''} Here's a copy of the conversation.`, files: [file()] }).catch(() => {});
  store.update((d) => { delete d.tickets.open[channel.id]; });
  await channel.send('🔒 Closing this ticket in 5 seconds…').catch(() => {});
  setTimeout(() => channel.delete(`Ticket #${t.number} closed`).catch(() => {}), 5000);
  return true;
}

async function handle(interaction, ctx) {
  const { store, config } = ctx;
  const [, , action, arg] = interaction.customId.split(':');

  if (action === 'open') {
    const t = TICKET_TYPES[arg];
    if (!t) return respond(interaction, 'That ticket type no longer exists.');
    if (arg === 'apply' && store.get('settings', 'staffApplicationsOpen') === false) return respond(interaction, 'Team applications are closed right now. Keep an eye on announcements!');
    const existing = openTicketOf(store, interaction.user.id);
    if (existing && interaction.guild.channels.cache.has(existing)) return respond(interaction, `You already have an open ticket: <#${existing}>`);
    if (existing) store.update((d) => { delete d.tickets.open[existing]; });
    const modal = new ModalBuilder().setCustomId(`pc:ticket:modal:${arg}`).setTitle(t.label);
    t.fields.forEach((f) => {
      const input = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.style).setRequired(f.required !== false);
      if (f.max) input.setMaxLength(f.max);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return interaction.showModal(modal);
  }

  if (action === 'modal') {
    const t = TICKET_TYPES[arg];
    if (!t) return respond(interaction, 'That ticket type no longer exists.');
    await interaction.deferReply({ flags: EPHEMERAL });
    const answers = Object.fromEntries(t.fields.map((f) => [f.id, interaction.fields.getTextInputValue(f.id)]));
    const channel = await createTicket(interaction, ctx, arg, answers);
    return interaction.editReply(`Your ticket is open: ${channel}`);
  }

  const ticket = store.get('tickets', 'open', interaction.channelId);
  if (!ticket) return respond(interaction, 'This isn\'t an open ticket anymore.');
  const staff = isStaff(interaction.member, store, config);

  if (action === 'claim') {
    if (!staff) return respond(interaction, 'Only staff can claim tickets.');
    store.update((d) => { d.tickets.open[interaction.channelId].claimedBy = interaction.user.id; });
    await interaction.update({ components: [controls(interaction.user.id)] });
    return interaction.channel.send(`🙋 ${interaction.user} is handling this ticket.`);
  }
  if (action === 'close') {
    if (!staff && interaction.user.id !== ticket.userId) return respond(interaction, 'Only staff or the person who opened this ticket can close it.');
    return respond(interaction, {
      content: 'Close this ticket? A transcript is saved for staff.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pc:ticket:confirm').setLabel('Close ticket').setStyle(ButtonStyle.Danger))],
    });
  }
  if (action === 'confirm') {
    if (!staff && interaction.user.id !== ticket.userId) return respond(interaction, 'Only staff or the person who opened this ticket can close it.');
    await interaction.update({ content: 'Closing…', components: [] });
    return closeTicket(interaction.channel, interaction.user, ctx);
  }
  return null;
}

module.exports = { TICKET_TYPES, handle, closeTicket, openTicketOf, USER_ALLOW };
