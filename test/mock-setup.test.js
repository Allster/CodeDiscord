'use strict';
// Runs /setup against an in-memory fake server to check it builds the layout, is safe to run twice,
// reuses existing channels, and gives the right people access. No Discord connection needed.
//   npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection, ChannelType, PermissionFlagsBits: P, PermissionsBitField, OverwriteType } = require('discord.js');
const { Store } = require('../src/lib/store');
const { runSetup } = require('../src/setup/runSetup');
const { ROLES, CATEGORIES } = require('../src/setup/blueprint');
const { parseDuration } = require('../src/lib/util');

let nextId = 1000n;
const snow = () => String(nextId++);

function fakeGuild({ admin = true, community = false, existing = [] } = {}) {
  const guild = { id: 'G1', name: 'Test Studio', ownerId: 'OWNER', features: community ? ['COMMUNITY'] : [], iconURL: () => null, sent: [], calls: { roleCreate: 0, channelCreate: 0, overwriteSet: 0, setParent: 0 } };
  const roles = new Collection();
  const everyone = { id: guild.id, name: '@everyone', position: 0, managed: false };
  roles.set(everyone.id, everyone);
  const botRole = { id: 'BOTROLE', name: 'PlayCode', position: 100, managed: true };
  roles.set(botRole.id, botRole);
  const perms = admin ? new PermissionsBitField(P.Administrator) : new PermissionsBitField([P.ManageRoles, P.ManageChannels, P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks]);
  const me = { id: 'BOT', permissions: { has: (p) => perms.has(P.Administrator) || perms.has(p) }, roles: { highest: botRole } };
  const owner = { id: 'OWNER', roles: { cache: new Collection(), add: async (r) => owner.roles.cache.set(r.id, r) } };

  roles.everyone = everyone;
  guild.roles = {
    cache: roles, everyone,
    fetch: async () => roles,
    create: async (o) => {
      guild.calls.roleCreate++;
      roles.forEach((r) => { if (!r.managed && r.id !== guild.id) r.position++; });
      const r = { id: snow(), name: o.name, position: 1, managed: false, permissions: new PermissionsBitField(o.permissions), color: o.color };
      roles.set(r.id, r); return r;
    },
  };
  const channels = new Collection();
  const makeChannel = (o) => {
    const ch = {
      id: snow(), name: o.name, type: o.type, parentId: o.parent || null, overwrites: o.permissionOverwrites || [], topic: o.topic,
      messages: new Collection(),
      isTextBased: () => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(o.type),
      setParent: async (pid) => { guild.calls.setParent++; ch.parentId = pid; },
      permissionOverwrites: { set: async (list) => { guild.calls.overwriteSet++; ch.overwrites = list; } },
      send: async (payload) => {
        const msg = { id: snow(), channelId: ch.id, url: `https://discord.com/channels/G1/${ch.id}/x`, payload, edit: async (p) => { msg.payload = p; msg.edited = (msg.edited || 0) + 1; return msg; } };
        ch.messages.set(msg.id, msg); guild.sent.push(msg); return msg;
      },
    };
    ch.delete = async () => { channels.delete(ch.id); ch.deleted = true; };
    ch.messages.fetch = async (id) => { if (typeof id === 'object') return ch.messages; const m = ch.messages.get(id); if (!m) throw new Error('Unknown Message'); return m; };
    channels.set(ch.id, ch); return ch;
  };
  existing.forEach((e) => makeChannel(e));
  guild.channels = {
    cache: channels,
    fetch: async (id) => (id ? channels.get(id) : channels),
    create: async (o) => { guild.calls.channelCreate++; return makeChannel(o); },
  };
  guild.makeChannel = makeChannel;
  guild.members = { me, fetchMe: async () => me, fetch: async (id) => (id === 'OWNER' ? owner : null) };
  guild.owner = owner;
  return guild;
}

const tmpStore = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'playcode-')));
const allow = (ch, id, bit) => ch.overwrites.some((o) => o.id === id && o.allow.includes(bit));
const deny = (ch, id, bit) => ch.overwrites.some((o) => o.id === id && o.deny.includes(bit));
const byKey = (guild, store, key) => guild.channels.cache.get(store.channelId(key));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const channelCount = CATEGORIES.reduce((n, c) => n + c.channels.length, 0);

test('first run builds every role, category, channel and panel', async () => {
  const g = fakeGuild(); const s = tmpStore();
  const r = await runSetup({ guild: g, store: s, options: { studioName: 'PlayCode Studios' } });
  assert.strictEqual(r.created.roles.length, ROLES.length);
  assert.strictEqual(r.created.categories.length, CATEGORIES.length);
  assert.strictEqual(r.created.channels.length, channelCount);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(r.panels.length, 5);
  assert.strictEqual(s.get('setup', 'studioName'), 'PlayCode Studios');
  assert.ok(s.get('setup', 'done'));
  // Roles end up in blueprint order (Studio Owner highest).
  const pos = ROLES.map((x) => g.roles.cache.get(s.roleId(x.key)).position);
  assert.deepStrictEqual([...pos].sort((a, b) => b - a), pos, 'roles out of order');
  assert.ok(g.owner.roles.cache.has(s.roleId('owner')), 'server owner should get Studio Owner');
  assert.ok(g.roles.cache.get(s.roleId('owner')).permissions.has(P.Administrator));
});

test('running again changes nothing and edits panels in place', async () => {
  const g = fakeGuild(); const s = tmpStore();
  await runSetup({ guild: g, store: s, options: {} });
  const before = { ...g.calls }; const sent = g.sent.length;
  const r = await runSetup({ guild: g, store: s, options: {} });
  assert.strictEqual(r.created.roles.length + r.created.channels.length + r.created.categories.length, 0);
  assert.strictEqual(g.calls.roleCreate, before.roleCreate);
  assert.strictEqual(g.calls.channelCreate, before.channelCreate);
  assert.strictEqual(g.sent.length, sent, 'panels should be edited, not re-posted');
  assert.ok(g.sent.every((m) => m.edited === 1));
});

test('preview changes nothing', async () => {
  const g = fakeGuild(); const s = tmpStore();
  const r = await runSetup({ guild: g, store: s, options: { preview: true } });
  assert.strictEqual(r.created.channels.length, channelCount);
  assert.strictEqual(g.calls.roleCreate + g.calls.channelCreate, 0);
  assert.ok(!s.get('setup', 'done'));
});

test('existing channels are taken over on the first run, then left as you tuned them', async () => {
  const keep = [{ id: 'x', allow: [P.ViewChannel], deny: [] }];
  const g = fakeGuild({ existing: [{ name: 'general', type: ChannelType.GuildText, permissionOverwrites: keep }, { name: 'Rules', type: ChannelType.GuildText }] });
  const s = tmpStore();
  const r = await runSetup({ guild: g, store: s, options: {} });
  assert.deepStrictEqual(r.adopted.channels.sort(), ['#Rules', '#general']);
  assert.strictEqual(r.created.channels.length, channelCount - 2);
  const general = byKey(g, s, 'general');
  assert.notStrictEqual(general.overwrites, keep, 'taken-over channel should get studio permissions');
  assert.ok(deny(general, g.id, P.ViewChannel) && allow(general, s.roleId('verified'), P.SendMessages));
  assert.strictEqual(general.parentId, s.get('setup', 'categories', 'catCommunity'));
  // Later runs leave hand-tuned permissions alone.
  const tuned = [{ id: 'y', allow: [P.ViewChannel], deny: [] }];
  general.overwrites = tuned;
  await runSetup({ guild: g, store: s, options: {} });
  assert.strictEqual(byKey(g, s, 'general').overwrites, tuned);
});

test('old team channels are cleaned up, but only empty ones in STUDIO TEAM', async () => {
  const g = fakeGuild(); const s = tmpStore();
  await runSetup({ guild: g, store: s, options: {} });
  const team = s.get('setup', 'categories', 'catTeam');
  const mk = (name, parent) => g.makeChannel({ name, type: ChannelType.GuildText, parent });
  const empty = ['scripting', 'building', 'git-feed'].map((n) => mk(n, team));
  const busy = mk('assets', team);
  busy.messages.set('m1', { author: { bot: false } });
  const elsewhere = mk('audio', s.get('setup', 'categories', 'catCommunity'));
  // Simulate the old version having recorded one of them.
  s.update((d) => { d.setup.channels.scripting = empty[0].id; });
  const preview = await runSetup({ guild: g, store: s, options: { preview: true } });
  assert.strictEqual(preview.removed.length, 4);
  assert.ok(empty.every((c) => !c.deleted), 'preview must not delete');
  const r = await runSetup({ guild: g, store: s, options: {} });
  assert.deepStrictEqual(r.removed.sort(), ['#building', '#git-feed', '#scripting']);
  assert.ok(empty.every((c) => c.deleted));
  assert.ok(!busy.deleted && r.warnings.some((w) => w.includes('#assets')));
  assert.ok(!elsewhere.deleted, 'same name in another category is left alone');
  assert.ok(!('scripting' in s.get('setup', 'channels')));
  assert.ok(byKey(g, s, 'teamChat') && byKey(g, s, 'tasks'));
});

test('permissions: unverified, members, team and staff see the right things', async () => {
  const g = fakeGuild(); const s = tmpStore();
  await runSetup({ guild: g, store: s, options: {} });
  const every = g.id; const ver = s.roleId('verified'); const scr = s.roleId('scripter'); const mod = s.roleId('moderator');
  const rules = byKey(g, s, 'rules'); const verifyCh = byKey(g, s, 'verify'); const general = byKey(g, s, 'general');
  const team = byKey(g, s, 'teamChat'); const staff = byKey(g, s, 'modLog'); const bugs = byKey(g, s, 'bugReports');
  assert.ok(allow(rules, every, P.ViewChannel) && deny(rules, every, P.SendMessages), 'rules readable, not writable');
  assert.ok(allow(verifyCh, every, P.ViewChannel) && deny(verifyCh, ver, P.ViewChannel), 'verify hides once verified');
  assert.ok(deny(general, every, P.ViewChannel) && allow(general, ver, P.SendMessages) && allow(general, scr, P.SendMessages), 'general for members');
  assert.ok(deny(team, every, P.ViewChannel) && !general.overwrites.some((o) => o.id === every && o.allow.length) && allow(team, scr, P.ViewChannel) && !team.overwrites.some((o) => o.id === ver), 'team only');
  assert.ok(deny(staff, every, P.ViewChannel) && allow(staff, mod, P.ViewChannel) && !staff.overwrites.some((o) => o.id === scr), 'staff only');
  assert.ok(allow(bugs, ver, P.ViewChannel) && deny(bugs, ver, P.SendMessages) && allow(bugs, ver, P.SendMessagesInThreads), 'bug feed: read + thread replies');
  for (const ch of g.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory && !ch.overwrites.length) continue;
    assert.ok(ch.overwrites.some((o) => o.id === 'BOT' && o.type === OverwriteType.Member && o.allow.includes(P.ViewChannel)), `bot must see ${ch.name}`);
    for (const o of ch.overwrites) for (const b of [...o.allow, ...o.deny]) assert.strictEqual(typeof b, 'bigint', `bad permission in ${ch.name}`);
    if (ch.type === ChannelType.GuildText) assert.ok(!ch.overwrites.some((o) => o.allow.includes(P.Connect)), `voice perms leaked into #${ch.name}`);
  }
  const vc = byKey(g, s, 'vcLounge');
  assert.strictEqual(vc.type, ChannelType.GuildVoice);
  assert.ok(allow(vc, ver, P.Connect));
});

test('verification off: no verify channel, @everyone treated as a member', async () => {
  const g = fakeGuild(); const s = tmpStore();
  const r = await runSetup({ guild: g, store: s, options: { verification: 'off' } });
  assert.ok(!s.channelId('verify'));
  assert.strictEqual(r.panels.length, 4);
  const general = byKey(g, s, 'general');
  assert.ok(!deny(general, g.id, P.ViewChannel));
  const news = byKey(g, s, 'announcements');
  assert.ok(allow(news, g.id, P.ViewChannel) && deny(news, g.id, P.SendMessages));
});

test('community servers get announcement channels', async () => {
  const g = fakeGuild({ community: true }); const s = tmpStore();
  await runSetup({ guild: g, store: s, options: {} });
  assert.strictEqual(byKey(g, s, 'announcements').type, ChannelType.GuildAnnouncement);
  assert.strictEqual(byKey(g, s, 'general').type, ChannelType.GuildText);
});

test('without Administrator: no admin role, trimmed perms, clear warnings', async () => {
  const g = fakeGuild({ admin: false }); const s = tmpStore();
  const r = await runSetup({ guild: g, store: s, options: {} });
  assert.ok(!g.roles.cache.get(s.roleId('owner')).permissions.has(P.Administrator));
  assert.ok(r.warnings.length >= 2);
  for (const ch of g.channels.cache.values()) for (const o of ch.overwrites) assert.ok(!o.allow.includes(P.ManageThreads), 'should not grant perms the bot lacks');
});

test('missing Manage Roles stops with a friendly error', async () => {
  const g = fakeGuild({ admin: false });
  g.members.me.permissions.has = (p) => p !== P.ManageRoles;
  await assert.rejects(runSetup({ guild: g, store: tmpStore(), options: {} }), (e) => e.friendly && /ManageRoles/.test(e.message));
});

test('helpers: durations', () => {
  assert.strictEqual(parseDuration('90'), 90 * 60e3);
  assert.strictEqual(parseDuration('1h30m'), 90 * 60e3);
  assert.strictEqual(parseDuration('2 d'), 2 * 86400e3);
  assert.strictEqual(parseDuration('soon'), null);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
  }
  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 400);
})();
