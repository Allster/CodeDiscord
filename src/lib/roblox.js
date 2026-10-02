'use strict';
// Roblox public web APIs (no key needed). Only public profile data is read.
const TIMEOUT = 8000;

async function getJson(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) } });
    if (res.status === 429) throw Object.assign(new Error('Roblox is rate limiting us. Try again in a minute.'), { friendly: true });
    if (!res.ok) throw new Error(`Roblox API ${res.status} for ${url}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Roblox took too long to answer. Try again in a minute.'), { friendly: true });
    throw e;
  } finally { clearTimeout(t); }
}

// Username → { id, name, displayName } or null.
async function findUser(username) {
  const name = String(username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return null;
  const data = await getJson('https://users.roblox.com/v1/usernames/users', { method: 'POST', body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }) });
  const u = data?.data?.[0];
  return u ? { id: u.id, name: u.name, displayName: u.displayName } : null;
}

// Full public profile: { id, name, displayName, description, created, isBanned, hasVerifiedBadge }.
async function getUser(id) {
  return getJson(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
}

async function getHeadshot(id) {
  try {
    const d = await getJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`);
    return d?.data?.[0]?.imageUrl || null;
  } catch { return null; }
}

const profileUrl = (id) => `https://www.roblox.com/users/${id}/profile`;

module.exports = { findUser, getUser, getHeadshot, profileUrl };
