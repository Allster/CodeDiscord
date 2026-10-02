'use strict';
// /post: announcements, game updates, devlogs and sneak peeks, written in a pop-up so line breaks work.
const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const { embed, isStaff, hasAnyRole, TEAM_KEYS, respond, EPHEMERAL } = require('../lib/util');

const KINDS = {
  announcement: { label: 'Announcement', channel: 'announcements', ping: null, color: 'brand', emoji: '📣', staffOnly: true },
  update: { label: 'Game update', channel: 'updates', ping: 'pingUpdates', color: 'ok', emoji: '🚀', staffOnly: true, version: true },
  devlog: { label: 'Devlog', channel: 'devlogs', ping: 'pingDevlogs', color: 'info', emoji: '🛠️' },
  sneakpeek: { label: 'Sneak peek', channel: 'devlogs', ping: 'pingDevlogs', color: 'warn', emoji: '👀' },
};

const pending = new Map(); // nonce → { kind, image, ping, everyone, userId, at }

function canPost(member, store, config, kind) {
  if (isStaff(member, store, config)) return true;
  return !KINDS[kind].staffOnly && hasAnyRole(member, store, TEAM_KEYS);
}

async function start(interaction, { store, config }) {
  const kind = interaction.options.getString('type', true);
  const k = KINDS[kind];
  if (!canPost(interaction.member, store, config, kind)) return respond(interaction, k.staffOnly ? 'Only staff can post that.' : 'Only the studio team can post devlogs.');
  if (!store.channelId(k.channel)) return respond(interaction, `The ${k.channel} channel isn't set up. Run /setup first.`);
  const image = interaction.options.getAttachment('image');
  if (image && !image.contentType?.startsWith('image/') && !image.contentType?.startsWith('video/')) return respond(interaction, 'The attachment has to be an image or video.');
  const nonce = interaction.id;
  for (const [n, p] of pending) if (Date.now() - p.at > 30 * 60e3) pending.delete(n);
  pending.set(nonce, { kind, image: image ? { url: image.url, name: image.name, video: image.contentType?.startsWith('video/') } : null, ping: interaction.options.getBoolean('ping') ?? true, everyone: interaction.options.getBoolean('ping_everyone') ?? false, userId: interaction.user.id, at: Date.now() });

  const modal = new ModalBuilder().setCustomId(`pc:post:modal:${nonce}`).setTitle(`New ${k.label.toLowerCase()}`);
  if (k.version) modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('version').setLabel('Version (optional)').setPlaceholder('v1.4.0').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(30)));
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('body').setLabel(k.version ? 'What changed? (one change per line)' : 'Message').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('link').setLabel('Link (game page, video…) optional').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)),
  );
  return interaction.showModal(modal);
}

async function handle(interaction, { store, config }) {
  const [, , , nonce] = interaction.customId.split(':');
  const p = pending.get(nonce);
  if (!p || p.userId !== interaction.user.id) return respond(interaction, 'That post expired. Run /post again.');
  pending.delete(nonce);
  await interaction.deferReply({ flags: EPHEMERAL });
  const k = KINDS[p.kind];
  const version = k.version ? interaction.fields.getTextInputValue('version').trim() : '';
  let body = interaction.fields.getTextInputValue('body').trim();
  if (k.version) body = body.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/^[-•*]/.test(l) ? `• ${l.replace(/^[-•*]\s*/, '')}` : `• ${l}`)).join('\n');
  let link = interaction.fields.getTextInputValue('link').trim();
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;

  const e = embed(k.color).setTitle(`${k.emoji} ${interaction.fields.getTextInputValue('title')}${version ? ` · ${version}` : ''}`)
    .setDescription(body).setAuthor({ name: interaction.member.displayName, iconURL: interaction.user.displayAvatarURL() })
    .setFooter({ text: `${k.label} · ${store.get('setup', 'studioName') || interaction.guild.name}` }).setTimestamp();
  if (link) { try { e.setURL(new URL(link).toString()); } catch { /* ignore bad links */ } }
  const files = [];
  if (p.image && !p.image.video) e.setImage(p.image.url);
  if (p.image?.video) files.push({ attachment: p.image.url, name: p.image.name });

  const pingRole = p.ping && k.ping ? store.roleId(k.ping) : null;
  const mentions = [p.everyone && isStaff(interaction.member, store, config) ? '@everyone' : null, pingRole ? `<@&${pingRole}>` : null].filter(Boolean);
  const channel = interaction.guild.channels.cache.get(store.channelId(k.channel));
  if (!channel) return interaction.editReply('That channel is gone. Run /setup to rebuild it.');
  const msg = await channel.send({
    content: mentions.join(' ') || undefined, embeds: [e], files,
    allowedMentions: { parse: mentions.includes('@everyone') ? ['everyone'] : [], roles: pingRole ? [pingRole] : [] },
  });
  if (channel.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
  return interaction.editReply(`Posted: ${msg.url}`);
}

module.exports = { start, handle, KINDS };
