'use strict';
// /embed send and /embed edit against fake Discord objects. No connection needed.
const assert = require('assert');
const { Collection, PermissionFlagsBits: P, ChannelType, EmbedBuilder } = require('discord.js');
const embedCmd = require('../src/commands/embed');
const { parseColor, parseFields, fieldsToText, parseMessageRef, cleanUrl } = embedCmd;

// Fake image downloads.
global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

const BOT = 'BOT1';
function world() {
  const sent = [];
  const channel = {
    id: '111111111111111111', type: ChannelType.GuildText, messages: new Collection(), isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      const embeds = payload.embeds.map((e) => toApi(e));
      const attachments = new Collection((payload.files || []).map((f, i) => [`A${i}`, { id: `A${i}`, name: f.name }]));
      const msg = {
        id: `22222222222222222${sent.length + 1}`, url: `https://discord.com/channels/333333333333333333/111111111111111111/22222222222222222${sent.length + 1}`, author: { id: BOT }, payload, embeds, attachments,
        edit: async (p) => { msg.lastEdit = p; msg.embeds = p.embeds.map(toApi); const kept = new Collection(p.attachments.map((a) => [a.id, a])); (p.files || []).forEach((f, i) => kept.set(`N${i}`, { id: `N${i}`, name: f.name })); msg.attachments = kept; return msg; },
        crosspost: async () => {},
      };
      channel.messages.set(msg.id, msg); sent.push(msg); return msg;
    },
  };
  channel.messages.fetch = async (id) => channel.messages.get(id) || null;
  const guild = { channels: { cache: new Collection([[channel.id, channel]]) }, members: { me: { id: BOT } } };
  return { channel, guild, sent };
}
// What Discord gives back for an embed: attachment:// links come back as CDN links.
function toApi(e) {
  const d = JSON.parse(JSON.stringify(e.toJSON ? e.toJSON() : e.data || e));
  for (const k of ['image', 'thumbnail']) if (d[k]?.url?.startsWith('attachment://')) d[k] = { url: `https://cdn.discordapp.com/attachments/x/${d[k].url.slice(13)}?ex=expires` };
  const out = { ...d, fields: d.fields || [], footer: d.footer, data: d };
  return out;
}

function staffMember() { return { id: 'U1', permissions: { has: (p) => p === P.Administrator }, roles: { cache: new Collection() }, guild: { ownerId: 'X' } }; }

function slash(w, sub, opts = {}) {
  const r = { modal: null, replies: [] };
  const i = {
    id: `I${Math.random()}`, user: { id: 'U1' }, member: staffMember(), guild: w.guild, channel: w.channel, channelId: w.channel.id, client: { user: { id: BOT } },
    options: {
      getSubcommand: () => sub, getString: (k) => opts[k] ?? null, getChannel: (k) => opts[k] ?? null, getRole: (k) => opts[k] ?? null,
      getBoolean: (k) => opts[k] ?? null, getAttachment: (k) => opts[k] ?? null,
    },
    showModal: async (m) => { r.modal = m.toJSON(); },
    reply: async (p) => { r.replies.push(p.content); }, deferred: false, replied: false,
  };
  return { i, r };
}

function submit(w, modal, values) {
  const r = { replies: [] };
  const i = {
    customId: modal.custom_id, user: { id: 'U1' }, guild: w.guild, deferred: false, replied: false,
    fields: { getTextInputValue: (k) => values[k] ?? '' },
    reply: async (p) => { r.replies.push(p.content); },
    deferReply: async () => { i.deferred = true; },
    editReply: async (p) => { r.replies.push(typeof p === 'string' ? p : p.content); },
  };
  return { i, r };
}

const ctx = { store: { roleId: () => null }, config: { ownerIds: [] } };
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('colour, field, link and message-link parsing', () => {
  assert.strictEqual(parseColor('#FF8800'), 0xff8800);
  assert.strictEqual(parseColor('f80'), 0xff8800);
  assert.strictEqual(parseColor('Gold'), 0xf5b301);
  assert.strictEqual(parseColor('banana'), null);
  const f = parseFields('Release | Friday\n\nPlatforms | PC, mobile | inline\nJust a name');
  assert.deepStrictEqual(f.map((x) => [x.name, x.value, x.inline]), [['Release', 'Friday', false], ['Platforms', 'PC, mobile', true], ['Just a name', '​', false]]);
  assert.strictEqual(fieldsToText(f), 'Release | Friday\nPlatforms | PC, mobile | inline\nJust a name | ');
  assert.strictEqual(parseFields(Array(30).fill('a | b').join('\n')).length, 25);
  assert.deepStrictEqual(parseMessageRef('https://discord.com/channels/1/22/333', 'C'), { channelId: '22', messageId: '333' });
  assert.deepStrictEqual(parseMessageRef('123456789012345678', 'C'), { channelId: 'C', messageId: '123456789012345678' });
  assert.strictEqual(parseMessageRef('hello', 'C'), null);
  assert.strictEqual(cleanUrl('roblox.com/games/1'), 'https://roblox.com/games/1');
  assert.strictEqual(cleanUrl('not a url'), undefined);
  assert.strictEqual(cleanUrl(''), null);
});

test('send: posts the embed with colour, fields, ping, image and thumbnail', async () => {
  const w = world();
  const img = { url: 'https://x/a.png', name: 'Big Pic.PNG', contentType: 'image/png', size: 100 };
  const th = { url: 'https://x/b.jpg', name: 'b.jpg', contentType: 'image/jpeg', size: 100 };
  const { i, r } = slash(w, 'send', { color: 'green', image: img, thumbnail: th, ping: { id: 'R9' }, timestamp: true });
  await embedCmd.commands[0].execute(i, ctx);
  assert.ok(r.modal, 'form should open');
  assert.strictEqual(r.modal.components.length, 5);
  const s = submit(w, r.modal, { title: 'Update 1.4', description: 'Line one\nLine two', fields: 'New map | Volcano\nFixes | 12 | inline', footer: 'Are Games', link: 'roblox.com/games/1' });
  await embedCmd.handle(s.i);
  assert.strictEqual(w.sent.length, 1);
  const p = w.sent[0].payload; const e = p.embeds[0].toJSON();
  assert.strictEqual(p.content, '<@&R9>');
  assert.deepStrictEqual(p.allowedMentions, { roles: ['R9'] });
  assert.strictEqual(e.color, 0x3ba55d);
  assert.strictEqual(e.title, 'Update 1.4');
  assert.strictEqual(e.url, 'https://roblox.com/games/1');
  assert.strictEqual(e.description, 'Line one\nLine two');
  assert.strictEqual(e.fields.length, 2); assert.strictEqual(e.fields[1].inline, true);
  assert.strictEqual(e.footer.text, 'Are Games');
  assert.ok(e.timestamp);
  assert.strictEqual(e.image.url, 'attachment://image.png');
  assert.strictEqual(e.thumbnail.url, 'attachment://thumbnail.jpg');
  assert.deepStrictEqual(p.files.map((f) => f.name), ['image.png', 'thumbnail.jpg']);
  assert.ok(/Posted:/.test(s.r.replies.at(-1)));
});

test('send: refuses bad colour, empty embed, bad link and non-staff', async () => {
  const w = world();
  let t = slash(w, 'send', { color: 'banana' });
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(!t.r.modal && /don't know the colour/.test(t.r.replies[0]));

  t = slash(w, 'send', {});
  await embedCmd.commands[0].execute(t.i, ctx);
  let s = submit(w, t.r.modal, {});
  await embedCmd.handle(s.i);
  assert.ok(/needs at least/.test(s.r.replies[0]) && w.sent.length === 0);

  t = slash(w, 'send', {});
  await embedCmd.commands[0].execute(t.i, ctx);
  s = submit(w, t.r.modal, { title: 'Hi', link: 'not a url' });
  await embedCmd.handle(s.i);
  assert.ok(/valid web address/.test(s.r.replies[0]) && w.sent.length === 0);

  t = slash(w, 'send', {});
  t.i.member = { id: 'U2', permissions: { has: () => false }, roles: { cache: new Collection() }, guild: { ownerId: 'X' } };
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(!t.r.modal && /Only staff/.test(t.r.replies[0]));

  t = slash(w, 'send', { image: { contentType: 'application/pdf', size: 1, name: 'a.pdf' } });
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(!t.r.modal && /has to be an image/.test(t.r.replies[0]));
});

test('edit: form is pre-filled, changes apply, kept image stays attached', async () => {
  const w = world();
  let t = slash(w, 'send', { color: 'red', image: { url: 'u', name: 'p.png', contentType: 'image/png', size: 5 } });
  await embedCmd.commands[0].execute(t.i, ctx);
  await embedCmd.handle(submit(w, t.r.modal, { title: 'Old', description: 'Typo hree', fields: 'A | 1', footer: 'F' }).i);
  const msg = w.sent[0];

  t = slash(w, 'edit', { message: msg.url });
  await embedCmd.commands[0].execute(t.i, ctx);
  const pre = Object.fromEntries(t.r.modal.components.map((row) => [row.components[0].custom_id, row.components[0].value]));
  assert.deepStrictEqual(pre, { title: 'Old', description: 'Typo hree', fields: 'A | 1', footer: 'F', link: undefined });
  const s = submit(w, t.r.modal, { ...pre, description: 'Typo here', title: 'New' });
  await embedCmd.handle(s.i);
  const e = msg.lastEdit.embeds[0].toJSON();
  assert.strictEqual(e.title, 'New');
  assert.strictEqual(e.description, 'Typo here');
  assert.strictEqual(e.color, 0xed4245, 'colour kept when not given');
  assert.strictEqual(e.image.url, 'attachment://image.png', 'kept image re-linked as an attachment');
  assert.deepStrictEqual(msg.lastEdit.attachments.map((a) => a.name), ['image.png']);
  assert.ok(/Updated:/.test(s.r.replies.at(-1)));

  // Remove images.
  t = slash(w, 'edit', { message: msg.url, remove_images: true, color: '#000000' });
  await embedCmd.commands[0].execute(t.i, ctx);
  await embedCmd.handle(submit(w, t.r.modal, { title: 'New', description: 'x' }).i);
  const e2 = msg.lastEdit.embeds[0].toJSON();
  assert.ok(!e2.image && msg.lastEdit.attachments.length === 0);
  assert.strictEqual(e2.color, 0);
});

test('edit: refuses messages it did not post or without an embed', async () => {
  const w = world();
  w.channel.messages.set('999999999999999999', { id: '999999999999999999', author: { id: 'someone' }, embeds: [{}] });
  let t = slash(w, 'edit', { message: '999999999999999999' });
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(/only edit messages I posted/.test(t.r.replies[0]));
  w.channel.messages.set('888888888888888888', { id: '888888888888888888', author: { id: BOT }, embeds: [] });
  t = slash(w, 'edit', { message: '888888888888888888' });
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(/doesn't have an embed/.test(t.r.replies[0]));
  t = slash(w, 'edit', { message: 'nope' });
  await embedCmd.commands[0].execute(t.i, ctx);
  assert.ok(/message link/.test(t.r.replies[0]));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`); }
  }
  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
