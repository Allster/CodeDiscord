'use strict';
// /playtest: schedule a test session, collect RSVPs, remind people 15 minutes before and at start.
// Reminders are driven by a 30-second tick over saved data, so they survive restarts.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { embed, ts, parseDuration, respond, isStaff, hasAnyRole, TEAM_KEYS, clip, sendTo } = require('../lib/util');

const RSVP = { going: { label: 'Going', emoji: '✅', style: ButtonStyle.Success }, maybe: { label: 'Maybe', emoji: '🤔', style: ButtonStyle.Secondary }, no: { label: 'Can\'t make it', emoji: '❌', style: ButtonStyle.Secondary } };
const EARLY = 15 * 60e3;

const count = (pt, k) => Object.values(pt.rsvps || {}).filter((v) => v === k).length;

function rows(id, pt) {
  const closed = pt.cancelled || Date.now() > pt.startsAt + (pt.durationMs || 60 * 60e3);
  return [new ActionRowBuilder().addComponents(Object.entries(RSVP).map(([k, r]) => new ButtonBuilder().setCustomId(`pc:pt:rsvp:${id}:${k}`).setLabel(`${r.label} · ${count(pt, k)}`).setEmoji(r.emoji).setStyle(r.style).setDisabled(closed)))];
}

function card(id, pt, store) {
  const vc = store.channelId('vcPlaytest');
  const e = embed(pt.cancelled ? 'muted' : 'warn').setTitle(`🧪 ${pt.cancelled ? '[Cancelled] ' : ''}${pt.title}`)
    .addFields(
      { name: 'When', value: `${ts(pt.startsAt, 'F')} (${ts(pt.startsAt, 'R')})`, inline: false },
      ...(pt.durationMs ? [{ name: 'Length', value: `about ${Math.round(pt.durationMs / 60e3)} min`, inline: true }] : []),
      ...(pt.link ? [{ name: 'Where', value: pt.link, inline: true }] : []),
      ...(vc ? [{ name: 'Voice', value: `<#${vc}>`, inline: true }] : []),
    ).setFooter({ text: `Playtest ${id} · hosted by ${pt.hostTag}` });
  if (pt.notes) e.setDescription(clip(pt.notes, 2000));
  return e;
}

async function create(interaction, { store, config }) {
  if (!isStaff(interaction.member, store, config) && !hasAnyRole(interaction.member, store, TEAM_KEYS)) return respond(interaction, 'Only the studio team can schedule playtests.');
  const ms = parseDuration(interaction.options.getString('starts_in', true));
  if (!ms || ms < 60e3 || ms > 60 * 86400e3) return respond(interaction, 'Give a start time like `30m`, `2h`, `1d4h` (between 1 minute and 60 days from now).');
  const dur = interaction.options.getString('length');
  const durationMs = dur ? parseDuration(dur) : null;
  if (dur && !durationMs) return respond(interaction, 'Length should look like `45m` or `1h30m`.');
  let link = interaction.options.getString('link') || '';
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  const id = Date.now().toString(36);
  const pt = { title: interaction.options.getString('title') || 'Playtest', startsAt: Date.now() + ms, durationMs, link, notes: interaction.options.getString('notes') || '', hostId: interaction.user.id, hostTag: interaction.user.tag, rsvps: {}, remindedEarly: ms <= EARLY, remindedStart: false, cancelled: false };
  const pingRole = store.roleId('pingPlaytests');
  const msg = await sendTo(interaction.guild, store, 'playtests', { content: pingRole ? `<@&${pingRole}>` : undefined, embeds: [card(id, pt, store)], components: rows(id, pt), allowedMentions: { roles: pingRole ? [pingRole] : [] } });
  if (!msg) return respond(interaction, 'The playtests channel isn\'t set up. Run /setup first.');
  store.update((d) => { d.playtests[id] = { ...pt, channelId: msg.channelId, messageId: msg.id }; });
  return respond(interaction, `Scheduled: ${msg.url} (id \`${id}\`)`);
}

async function cancel(interaction, { store, config }) {
  const id = interaction.options.getString('id', true);
  const pt = store.get('playtests', id);
  if (!pt) return respond(interaction, 'No playtest with that id. It\'s in the footer of the post.');
  if (pt.hostId !== interaction.user.id && !isStaff(interaction.member, store, config)) return respond(interaction, 'Only the host or staff can cancel it.');
  store.update((d) => { d.playtests[id].cancelled = true; });
  await refresh(interaction.guild, store, id);
  return respond(interaction, 'Cancelled.');
}

async function refresh(guild, store, id) {
  const pt = store.get('playtests', id);
  const ch = pt && guild.channels.cache.get(pt.channelId);
  const msg = ch && await ch.messages.fetch(pt.messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [card(id, pt, store)], components: rows(id, pt) }).catch(() => {});
}

async function handle(interaction, { store }) {
  const [, , , id, choice] = interaction.customId.split(':');
  const pt = store.get('playtests', id);
  if (!pt || !RSVP[choice]) return respond(interaction, 'This playtest is no longer tracked.');
  store.update((d) => {
    const r = d.playtests[id].rsvps;
    if (r[interaction.user.id] === choice) delete r[interaction.user.id]; else r[interaction.user.id] = choice;
  });
  const fresh = store.get('playtests', id);
  return interaction.update({ embeds: [card(id, fresh, store)], components: rows(id, fresh) });
}

// Called every 30 seconds.
async function tick(guild, store) {
  const now = Date.now();
  for (const [id, pt] of Object.entries(store.get('playtests'))) {
    if (pt.cancelled) continue;
    const going = Object.entries(pt.rsvps || {}).filter(([, v]) => v === 'going').map(([u]) => `<@${u}>`);
    const ch = guild.channels.cache.get(pt.channelId);
    if (!pt.remindedEarly && now >= pt.startsAt - EARLY) {
      store.update((d) => { d.playtests[id].remindedEarly = true; });
      if (ch) await ch.send({ content: `⏰ **${pt.title}** starts ${ts(pt.startsAt, 'R')}. ${going.join(' ')}`.trim(), allowedMentions: { users: Object.keys(pt.rsvps || {}).filter((u) => pt.rsvps[u] === 'going') } }).catch(() => {});
    }
    if (!pt.remindedStart && now >= pt.startsAt) {
      store.update((d) => { d.playtests[id].remindedStart = true; });
      const role = store.roleId('pingPlaytests');
      const vc = store.channelId('vcPlaytest');
      if (ch) await ch.send({ content: `🧪 **${pt.title}** is starting now!${pt.link ? ` ${pt.link}` : ''}${vc ? ` Hop in <#${vc}>.` : ''}\n${[role ? `<@&${role}>` : '', ...going].join(' ')}`.trim(), allowedMentions: { roles: role ? [role] : [], users: Object.keys(pt.rsvps || {}).filter((u) => pt.rsvps[u] === 'going') } }).catch(() => {});
    }
    // Drop finished playtests after a week, and disable buttons once they're over.
    const end = pt.startsAt + (pt.durationMs || 60 * 60e3);
    if (now > end && !pt.closed) { store.update((d) => { d.playtests[id].closed = true; }); await refresh(guild, store, id); }
    if (now > end + 7 * 86400e3) store.update((d) => { delete d.playtests[id]; });
  }
}

module.exports = { create, cancel, handle, tick };
