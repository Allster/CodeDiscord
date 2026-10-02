'use strict';
// The messages /setup posts: welcome, rules, verify, ping-role menu and ticket panel.
// postOrEdit() remembers each one so re-running /setup (or /panel) edits it instead of posting a duplicate.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { ROLES, RULES } = require('./blueprint');
const { embed } = require('../lib/util');
const { TICKET_TYPES } = require('../features/tickets');

const ch = (store, key, fallback) => (store.channelId(key) ? `<#${store.channelId(key)}>` : fallback);
const studio = (store, guild) => store.get('setup', 'studioName') || guild.name;

function welcomePanel(store, guild) {
  const verifying = store.get('settings', 'verification') !== 'off';
  const steps = [
    `**1.** Read the ${ch(store, 'rules', '#rules')}.`,
    verifying ? `**2.** Verify your Roblox account with \`/verify\` in ${ch(store, 'verify', '#verify')} to unlock the server.` : null,
    `**${verifying ? 3 : 2}.** Pick your pings in ${ch(store, 'roles', '#roles')}.`,
    `**${verifying ? 4 : 3}.** Say hi in ${ch(store, 'general', '#general')}.`,
  ].filter(Boolean);
  return {
    embeds: [embed().setTitle(`Welcome to ${studio(store, guild)}`)
      .setDescription(`We make Roblox games, and this is where the community and the team hang out.\n\n${steps.join('\n')}`)
      .addFields(
        { name: 'Stay up to date', value: `${ch(store, 'announcements', '#announcements')} · ${ch(store, 'updates', '#game-updates')} · ${ch(store, 'devlogs', '#devlogs')}`, inline: false },
        { name: 'Found a bug or have an idea?', value: 'Use **/bug** or **/suggest** anywhere in the server.', inline: false },
        { name: 'Need help?', value: `Open a private ticket in ${ch(store, 'support', '#support')}.`, inline: false },
      )
      .setThumbnail(guild.iconURL({ size: 256 }) || null)],
  };
}

function rulesPanel(store, guild) {
  return {
    embeds: [embed().setTitle(`${studio(store, guild)} rules`)
      .setDescription(RULES.map(([t, d], i) => `**${i + 1}. ${t}**\n${d}`).join('\n\n'))
      .setFooter({ text: 'Breaking the rules can get you warned, timed out, kicked or banned.' })],
  };
}

function verifyPanel(store) {
  return {
    embeds: [embed('ok').setTitle('Verify with Roblox')
      .setDescription([
        'Link your Roblox account to unlock the rest of the server.',
        '',
        '**1.** Type **`/verify`** in this channel and pick the **RoVer** command.',
        '**2.** Follow RoVer\'s steps to link your Roblox account.',
        '**3.** Once you\'re verified, this channel disappears and the server opens up.',
        '',
        'Already verified but still stuck here? Type **`/update`** and RoVer will refresh your roles.',
        'We never ask for your Roblox password.',
      ].join('\n'))],
  };
}

function rolesPanel(store) {
  const pings = ROLES.filter((r) => r.group === 'ping' && store.roleId(r.key));
  const menu = new StringSelectMenuBuilder().setCustomId('pc:roles:select').setPlaceholder('Choose your pings')
    .setMinValues(0).setMaxValues(Math.max(1, pings.length))
    .addOptions(pings.length ? pings.map((r) => ({ label: r.name, value: r.key, description: r.description, emoji: r.emoji })) : [{ label: 'Run /setup first', value: 'none' }]);
  return {
    embeds: [embed().setTitle('Pick your pings')
      .setDescription(`Choose what you want to be pinged for. Pick again any time to change it.\n\n${pings.map((r) => `${r.emoji} **${r.name}**: ${r.description}`).join('\n')}`)],
    components: [
      new ActionRowBuilder().addComponents(menu),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('pc:roles:clear').setLabel('Remove all pings').setStyle(ButtonStyle.Secondary)),
    ],
  };
}

function ticketPanel(store) {
  const applicationsOpen = store.get('settings', 'staffApplicationsOpen') !== false;
  const types = Object.entries(TICKET_TYPES).filter(([k]) => k !== 'apply' || applicationsOpen);
  return {
    embeds: [embed().setTitle('Support')
      .setDescription(`Need a hand? Open a private ticket and the team will get back to you.\n\n${types.map(([, t]) => `${t.emoji} **${t.label}**: ${t.blurb}`).join('\n')}\n\nFor bugs in the game, use **/bug** instead so everyone can see it's known.`)],
    components: [new ActionRowBuilder().addComponents(types.map(([k, t]) => new ButtonBuilder().setCustomId(`pc:ticket:open:${k}`).setLabel(t.label).setEmoji(t.emoji).setStyle(k === 'support' ? ButtonStyle.Primary : ButtonStyle.Secondary)))],
  };
}

const PANELS = {
  welcome: { channel: 'welcome', build: welcomePanel },
  rules: { channel: 'rules', build: rulesPanel },
  verify: { channel: 'verify', build: verifyPanel },
  roles: { channel: 'roles', build: rolesPanel },
  tickets: { channel: 'support', build: ticketPanel },
};

async function postOrEdit(guild, store, panelKey, channelKey, payload) {
  const channelId = store.channelId(channelKey);
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const saved = store.get('setup', 'messages', panelKey);
  if (saved?.channelId === channel.id && saved.messageId) {
    const msg = await channel.messages.fetch(saved.messageId).catch(() => null);
    if (msg) { await msg.edit({ components: [], ...payload }); return msg; }
  }
  const msg = await channel.send(payload);
  store.update((d) => { d.setup.messages[panelKey] = { channelId: channel.id, messageId: msg.id }; });
  return msg;
}

module.exports = { welcomePanel, rulesPanel, verifyPanel, rolesPanel, ticketPanel, postOrEdit, PANELS };
