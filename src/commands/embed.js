'use strict';
// /embed send and /embed edit: staff build custom embeds in a pop-up form (so line breaks work).
// Images are re-uploaded with the message, because attachment links from a slash command expire.
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { isStaff, respond, COLORS, EPHEMERAL } = require('../lib/util');

const NAMED = {
  blurple: COLORS.brand, blue: COLORS.info, green: COLORS.ok, yellow: COLORS.warn, gold: 0xf5b301, orange: 0xff6b3d,
  red: COLORS.bad, pink: 0xe91e63, purple: 0x9b59b6, teal: 0x1abc9c, grey: COLORS.muted, gray: COLORS.muted, white: 0xffffff, black: 0x111214,
};
const MAX_FILE = 10 * 1024 * 1024;
const pending = new Map(); // interaction id → what the form needs once it's submitted

// "#ff8800", "ff8800", "f80" or a colour name → number, or null if it can't be read.
function parseColor(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s] !== undefined) return NAMED[s];
  const hex = s.replace(/^#|^0x/, '');
  if (/^[0-9a-f]{6}$/.test(hex)) return parseInt(hex, 16);
  if (/^[0-9a-f]{3}$/.test(hex)) return parseInt(hex.split('').map((c) => c + c).join(''), 16);
  return null;
}

function cleanUrl(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString() : undefined; } catch { return undefined; }
}

// Download a slash-command attachment so it can be re-uploaded with the message.
async function grab(att) {
  if (!att) return null;
  if (!att.contentType?.startsWith('image/')) throw Object.assign(new Error('Images only (PNG, JPG, GIF or WebP).'), { friendly: true });
  if (att.size > MAX_FILE) throw Object.assign(new Error('That image is over 10 MB.'), { friendly: true });
  const res = await fetch(att.url);
  if (!res.ok) throw Object.assign(new Error('I couldn\'t download that image. Try uploading it again.'), { friendly: true });
  const ext = (att.name.match(/\.(png|jpe?g|gif|webp)$/i)?.[1] || 'png').toLowerCase();
  return { buffer: Buffer.from(await res.arrayBuffer()), ext };
}

function input(id, label, style, { value, max, placeholder, required = false } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (max) t.setMaxLength(max);
  if (placeholder) t.setPlaceholder(placeholder);
  if (value) t.setValue(String(value).slice(0, max || 4000));
  return new ActionRowBuilder().addComponents(t);
}

function form(id, title, current = {}) {
  return new ModalBuilder().setCustomId(`pc:embed:modal:${id}`).setTitle(title).addComponents(
    input('title', 'Title', TextInputStyle.Short, { value: current.title, max: 256 }),
    input('description', 'Text (Markdown and line breaks work)', TextInputStyle.Paragraph, { value: current.description, max: 4000 }),
    input('fields', 'Fields: one per line, Name | Value', TextInputStyle.Paragraph, { value: current.fields, max: 3000, placeholder: 'Release date | Friday 6pm CT\nPlatforms | PC, mobile, console' }),
    input('footer', 'Footer', TextInputStyle.Short, { value: current.footer, max: 2048 }),
    input('link', 'Title link (optional)', TextInputStyle.Short, { value: current.link, max: 400, placeholder: 'https://www.roblox.com/games/...' }),
  );
}

// "Name | Value" lines → embed fields. A line without "|" becomes a field with that name and a blank-looking value.
function parseFields(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('|');
    let name = (i === -1 ? line : line.slice(0, i)).trim();
    let value = (i === -1 ? '' : line.slice(i + 1)).trim();
    let inline = false;
    if (/\|\s*inline\s*$/i.test(value)) { inline = true; value = value.replace(/\|\s*inline\s*$/i, '').trim(); }
    name = name.slice(0, 256) || '​';
    value = value.slice(0, 1024) || '​';
    out.push({ name, value, inline });
    if (out.length === 25) break;
  }
  return out;
}

const fieldsToText = (fields = []) => fields.map((f) => `${f.name === '​' ? '' : f.name} | ${f.value === '​' ? '' : f.value}${f.inline ? ' | inline' : ''}`).join('\n');

// Discord message link → { channelId, messageId }, or a bare message ID in the current channel.
function parseMessageRef(text, fallbackChannelId) {
  const s = String(text || '').trim();
  const m = s.match(/channels\/(\d+|@me)\/(\d+)\/(\d+)/);
  if (m) return { channelId: m[2], messageId: m[3] };
  if (/^\d{17,20}$/.test(s)) return { channelId: fallbackChannelId, messageId: s };
  return null;
}

const data = new SlashCommandBuilder().setName('embed').setDescription('Staff: post or edit a custom embed')
  .setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
  .addSubcommand((s) => s.setName('send').setDescription('Write a new embed and post it')
    .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: this channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption((o) => o.setName('color').setDescription('Hex like #ff8800, or a name: blue, green, red, gold, purple…').setMaxLength(20))
    .addAttachmentOption((o) => o.setName('image').setDescription('Big image at the bottom'))
    .addAttachmentOption((o) => o.setName('thumbnail').setDescription('Small image in the top right'))
    .addRoleOption((o) => o.setName('ping').setDescription('Ping this role above the embed'))
    .addBooleanOption((o) => o.setName('timestamp').setDescription('Show the time it was posted')))
  .addSubcommand((s) => s.setName('edit').setDescription('Edit an embed the bot already posted')
    .addStringOption((o) => o.setName('message').setDescription('Message link (right-click the message → Copy Message Link)').setRequired(true))
    .addStringOption((o) => o.setName('color').setDescription('New colour (leave empty to keep it)').setMaxLength(20))
    .addAttachmentOption((o) => o.setName('image').setDescription('Replace the big image'))
    .addAttachmentOption((o) => o.setName('thumbnail').setDescription('Replace the small image'))
    .addBooleanOption((o) => o.setName('remove_images').setDescription('Remove the image and thumbnail')));

async function execute(interaction, ctx) {
  if (!isStaff(interaction.member, ctx.store, ctx.config)) return respond(interaction, 'Only staff can use /embed.');
  const sub = interaction.options.getSubcommand();
  const colorText = interaction.options.getString('color');
  const color = colorText ? parseColor(colorText) : null;
  if (colorText && color === null) return respond(interaction, `I don't know the colour "${colorText}". Use a hex code like \`#ff8800\` or a name like blue, green, red, gold or purple.`);
  for (const o of ['image', 'thumbnail']) {
    const att = interaction.options.getAttachment(o);
    if (att && !att.contentType?.startsWith('image/')) return respond(interaction, `The ${o} has to be an image.`);
    if (att && att.size > MAX_FILE) return respond(interaction, `The ${o} is over 10 MB.`);
  }
  for (const [n, p] of pending) if (Date.now() - p.at > 30 * 60e3) pending.delete(n);
  const base = { userId: interaction.user.id, at: Date.now(), color, image: interaction.options.getAttachment('image'), thumbnail: interaction.options.getAttachment('thumbnail') };

  if (sub === 'send') {
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles])) return respond(interaction, `I can't post embeds in ${channel}. I need View Channel, Send Messages, Embed Links and Attach Files there.`);
    const ping = interaction.options.getRole('ping');
    pending.set(interaction.id, { ...base, mode: 'send', channelId: channel.id, pingId: ping?.id || null, timestamp: interaction.options.getBoolean('timestamp') ?? false });
    return interaction.showModal(form(interaction.id, 'New embed'));
  }

  // edit
  const ref = parseMessageRef(interaction.options.getString('message', true), interaction.channelId);
  if (!ref) return respond(interaction, 'Paste a message link (right-click the message → Copy Message Link).');
  const channel = interaction.guild.channels.cache.get(ref.channelId);
  const msg = channel?.isTextBased?.() && await channel.messages.fetch(ref.messageId).catch(() => null);
  if (!msg) return respond(interaction, 'I can\'t find that message. Make sure the link is from this server and I can see that channel.');
  if (msg.author.id !== interaction.client.user.id) return respond(interaction, 'I can only edit messages I posted.');
  const e = msg.embeds[0];
  if (!e) return respond(interaction, 'That message doesn\'t have an embed.');
  pending.set(interaction.id, { ...base, mode: 'edit', channelId: channel.id, messageId: msg.id, removeImages: interaction.options.getBoolean('remove_images') ?? false });
  return interaction.showModal(form(interaction.id, 'Edit embed', { title: e.title, description: e.description, fields: fieldsToText(e.fields), footer: e.footer?.text, link: e.url }));
}

async function handle(interaction) {
  const id = interaction.customId.split(':')[3];
  const p = pending.get(id);
  if (!p || p.userId !== interaction.user.id) return respond(interaction, 'That form expired. Run /embed again.');
  pending.delete(id);

  const v = (k) => interaction.fields.getTextInputValue(k).trim();
  const title = v('title'); const description = v('description'); const footer = v('footer');
  const fields = parseFields(v('fields'));
  const link = cleanUrl(v('link'));
  if (link === undefined) return respond(interaction, 'The title link isn\'t a valid web address. Nothing was posted. Run /embed again.');
  if (!title && !description && !fields.length && !p.image && !p.thumbnail) return respond(interaction, 'An embed needs at least a title, text, a field or an image. Nothing was posted.');
  if (link && !title) return respond(interaction, 'A title link needs a title to attach to. Nothing was posted.');
  const total = title.length + description.length + footer.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (total > 6000) return respond(interaction, `That's ${total} characters; Discord's limit for one embed is 6,000. Nothing was posted.`);

  await interaction.deferReply({ flags: EPHEMERAL });
  const channel = interaction.guild.channels.cache.get(p.channelId);
  if (!channel) return interaction.editReply('That channel is gone.');
  const [img, thumb] = await Promise.all([grab(p.image), grab(p.thumbnail)]);
  const files = [];
  if (img) files.push(new AttachmentBuilder(img.buffer, { name: `image.${img.ext}` }));
  if (thumb) files.push(new AttachmentBuilder(thumb.buffer, { name: `thumbnail.${thumb.ext}` }));

  if (p.mode === 'send') {
    const e = new EmbedBuilder().setColor(p.color ?? COLORS.brand);
    if (title) e.setTitle(title);
    if (link) e.setURL(link);
    if (description) e.setDescription(description);
    if (fields.length) e.addFields(fields);
    if (footer) e.setFooter({ text: footer });
    if (p.timestamp) e.setTimestamp();
    if (img) e.setImage(`attachment://image.${img.ext}`);
    if (thumb) e.setThumbnail(`attachment://thumbnail.${thumb.ext}`);
    const msg = await channel.send({ content: p.pingId ? `<@&${p.pingId}>` : undefined, embeds: [e], files, allowedMentions: { roles: p.pingId ? [p.pingId] : [] } });
    if (channel.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
    return interaction.editReply(`Posted: ${msg.url}\nTo change it later: \`/embed edit\` with that link.`);
  }

  const msg = await channel.messages.fetch(p.messageId).catch(() => null);
  if (!msg?.embeds[0]) return interaction.editReply('That message or its embed is gone.');
  const old = msg.embeds[0];
  const e = EmbedBuilder.from(old).setTitle(title || null).setURL(link || null).setDescription(description || null).setFields(fields).setFooter(footer ? { text: footer, iconURL: old.footer?.iconURL } : null);
  if (p.color !== null) e.setColor(p.color);
  // Keep existing uploaded images unless they're being replaced or removed.
  const keep = p.removeImages ? [] : [...msg.attachments.values()].filter((a) => !(img && a.name.startsWith('image.')) && !(thumb && a.name.startsWith('thumbnail.')));
  if (p.removeImages) { e.setImage(null); e.setThumbnail(null); }
  // Point kept images back at their attached files, so Discord doesn't store a link that expires.
  for (const a of keep) {
    if (a.name.startsWith('image.') && old.image) e.setImage(`attachment://${a.name}`);
    if (a.name.startsWith('thumbnail.') && old.thumbnail) e.setThumbnail(`attachment://${a.name}`);
  }
  if (img) e.setImage(`attachment://image.${img.ext}`);
  if (thumb) e.setThumbnail(`attachment://thumbnail.${thumb.ext}`);
  await msg.edit({ embeds: [e], files, attachments: keep });
  return interaction.editReply(`Updated: ${msg.url}`);
}

module.exports = { commands: [{ data, execute }], handle, parseColor, parseFields, fieldsToText, parseMessageRef, cleanUrl };
