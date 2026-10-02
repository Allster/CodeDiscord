'use strict';
const { EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const EPHEMERAL = MessageFlags.Ephemeral;

const COLORS = { brand: 0x5865f2, ok: 0x3ba55d, warn: 0xf0b232, bad: 0xed4245, info: 0x4aa3df, muted: 0x99aab5 };

const embed = (color = 'brand') => new EmbedBuilder().setColor(COLORS[color] ?? color);

// Role keys that count as staff / studio team / members (see blueprint groups).
const STAFF_KEYS = ['owner', 'lead', 'moderator'];
const TEAM_KEYS = [...STAFF_KEYS, 'scripter', 'builder', 'modeler', 'ui', 'animator', 'audio', 'tester'];

function hasAnyRole(member, store, keys) {
  if (!member?.roles?.cache) return false;
  return keys.some((k) => { const id = store.roleId(k); return id && member.roles.cache.has(id); });
}

// Staff = configured owner IDs, server owner, Administrator/Manage Server, or a staff role from /setup.
function isStaff(member, store, config) {
  if (!member) return false;
  if (config?.ownerIds?.includes(member.id)) return true;
  if (member.guild?.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator) || member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return hasAnyRole(member, store, STAFF_KEYS);
}

function isAdmin(member, config) {
  if (!member) return false;
  if (config?.ownerIds?.includes(member.id) || member.guild?.ownerId === member.id) return true;
  return !!(member.permissions?.has?.(PermissionFlagsBits.Administrator) || member.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

// "30m", "2h", "1d12h", "90" (minutes) → milliseconds. Returns null if it can't be read.
function parseDuration(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 60e3;
  const re = /(\d+(?:\.\d+)?)(w|d|h|m|s)/g;
  const unit = { w: 604800e3, d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };
  let total = 0; let used = 0; let m;
  while ((m = re.exec(s))) { total += Number(m[1]) * unit[m[2]]; used += m[0].length; }
  return used === s.length && total > 0 ? Math.round(total) : null;
}

function formatDuration(ms) {
  const parts = [];
  const units = [['d', 86400e3], ['h', 3600e3], ['m', 60e3]];
  for (const [u, n] of units) { const v = Math.floor(ms / n); if (v) { parts.push(`${v}${u}`); ms -= v * n; } }
  return parts.join(' ') || `${Math.round(ms / 1000)}s`;
}

const ts = (date, style = 'f') => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

async function safeDM(user, payload) {
  try { await user.send(payload); return true; } catch { return false; }
}

// Send to a channel the bot set up, by key. Quietly does nothing if it no longer exists.
async function sendTo(guild, store, key, payload) {
  const id = store.channelId(key);
  if (!id) return null;
  const ch = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
  if (!ch?.isTextBased?.()) return null;
  return ch.send(payload).catch((e) => { console.warn(`[send:${key}] ${e.message}`); return null; });
}

const modLog = (guild, store, payload) => sendTo(guild, store, 'modLog', payload);

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Reply or follow up, whichever is valid right now.
async function respond(interaction, payload) {
  const p = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred || interaction.replied) return interaction.followUp({ flags: EPHEMERAL, ...p }).catch(() => {});
  return interaction.reply({ flags: EPHEMERAL, ...p }).catch(() => {});
}

module.exports = { EPHEMERAL, COLORS, embed, STAFF_KEYS, TEAM_KEYS, hasAnyRole, isStaff, isAdmin, parseDuration, formatDuration, ts, safeDM, sendTo, modLog, clip, respond };
