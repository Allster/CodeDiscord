'use strict';
// /setup engine. Builds (or repairs) the server from blueprint.js. Safe to run again: anything that
// already exists is reused by ID, or adopted by name, instead of being duplicated.
const { ChannelType, PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const { ROLES, CATEGORIES, RETIRED } = require('./blueprint');
const panels = require('./panels');
const { TEAM_KEYS, STAFF_KEYS } = require('../lib/util');

const VIEW = [P.ViewChannel, P.ReadMessageHistory];
const TALK = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseApplicationCommands, P.Connect, P.Speak, P.Stream, P.UseVAD];
const MOD = [P.ManageMessages, P.ManageThreads, P.MuteMembers, P.MoveMembers];
const BOT = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.EmbedLinks, P.AttachFiles, P.AddReactions, P.ManageMessages, P.ManageThreads, P.ManageChannels, P.Connect];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Who can see/talk where. Returns a list of overwrites (before filtering to what the bot may grant).
function overwritesFor(profile, ctx, { voice = false } = {}) {
  const { everyone, members, team, staff, verified, botId, verification } = ctx;
  const open = verification === 'off'; // with verification off, @everyone is a member
  const ow = [];
  const add = (id, allow = [], deny = [], type = OverwriteType.Role) => { if (id) ow.push({ id, allow, deny, type }); };
  const readOnlyDeny = [P.SendMessages, P.CreatePublicThreads, P.CreatePrivateThreads];

  switch (profile) {
    case 'public':
      add(everyone, VIEW, readOnlyDeny);
      break;
    case 'gate':
      add(everyone, VIEW, readOnlyDeny);
      add(verified, [], [P.ViewChannel]);
      break;
    case 'news':
    case 'botfeed': {
      const extraDeny = profile === 'news' ? [] : [P.CreatePublicThreads];
      if (open) add(everyone, [...VIEW, P.AddReactions, P.SendMessagesInThreads], [...readOnlyDeny, ...extraDeny]);
      else {
        add(everyone, [], [P.ViewChannel]);
        members.forEach((id) => add(id, [...VIEW, P.AddReactions, P.SendMessagesInThreads], [...readOnlyDeny, ...extraDeny]));
      }
      break;
    }
    case 'chat':
      if (!open) {
        add(everyone, [], [P.ViewChannel, P.Connect]);
        members.forEach((id) => add(id, [...VIEW, ...TALK]));
      }
      break;
    case 'team':
      add(everyone, [], [P.ViewChannel, P.Connect]);
      team.forEach((id) => add(id, [...VIEW, ...TALK]));
      break;
    case 'staff':
    case 'hidden':
      add(everyone, [], [P.ViewChannel, P.Connect]);
      break;
    default:
  }
  // Staff can always see and moderate; the bot can always work in its own channels.
  staff.forEach((id) => add(id, [...VIEW, ...TALK, ...MOD]));
  add(botId, BOT, [], OverwriteType.Member);
  if (!voice) return ow.map((o) => ({ ...o, allow: o.allow.filter((p) => ![P.Connect, P.Speak, P.Stream, P.UseVAD, P.MuteMembers, P.MoveMembers].includes(p)), deny: o.deny.filter((p) => p !== P.Connect) }));
  return ow;
}

// Discord refuses overwrites that grant something the bot itself lacks (unless it's an admin).
function grantable(overwrites, me) {
  if (me.permissions.has(P.Administrator)) return { list: overwrites, dropped: [] };
  const dropped = new Set();
  const list = overwrites.map((o) => ({
    ...o,
    allow: o.allow.filter((p) => { const ok = me.permissions.has(p); if (!ok) dropped.add(p); return ok; }),
    deny: o.deny.filter((p) => { const ok = me.permissions.has(p); if (!ok) dropped.add(p); return ok; }),
  }));
  return { list, dropped: [...dropped] };
}

const permName = (bit) => Object.keys(P).find((k) => P[k] === bit) || String(bit);

async function runSetup({ guild, store, options = {}, progress = () => {} }) {
  const opts = {
    studioName: options.studioName || store.get('setup', 'studioName') || guild.name,
    // RoVer handles Roblox verification and gives the Verified role. 'off' skips the gate entirely.
    verification: (options.verification || store.get('settings', 'verification')) === 'off' ? 'off' : 'rover',
    fixPermissions: !!options.fixPermissions,
    postPanels: options.postPanels !== false,
    preview: !!options.preview,
  };
  const me = guild.members.me || await guild.members.fetchMe();
  const report = { preview: opts.preview, created: { roles: [], categories: [], channels: [] }, adopted: { roles: [], categories: [], channels: [] }, removed: [], repaired: [], panels: [], warnings: [], opts };

  // 0. Can we do this at all?
  const needed = [P.ManageRoles, P.ManageChannels];
  const missing = needed.filter((p) => !me.permissions.has(p));
  if (missing.length) {
    const err = new Error(`I'm missing ${missing.map(permName).join(' and ')}. Give my role those permissions (or Administrator) and run /setup again.`);
    err.friendly = true;
    throw err;
  }
  if (!me.permissions.has(P.Administrator)) report.warnings.push('I don\'t have Administrator, so the Studio Owner role was made without it and some channel permissions may be trimmed. Giving my role Administrator and re-running with fix_permissions fills those in.');

  await guild.roles.fetch();
  await guild.channels.fetch();

  // 1. Roles, top to bottom. New roles land just above @everyone, so creating in blueprint order keeps them in order.
  progress('Roles');
  const roleIds = { ...store.get('setup', 'roles') };
  for (const r of ROLES) {
    let role = roleIds[r.key] && guild.roles.cache.get(roleIds[r.key]);
    if (!role) {
      role = guild.roles.cache.find((x) => !x.managed && x.id !== guild.id && norm(x.name) === norm(r.name));
      if (role) report.adopted.roles.push(role.name);
    }
    if (!role) {
      const perms = (r.perms || []).map((k) => P[k]).filter((p) => me.permissions.has(P.Administrator) || me.permissions.has(p));
      if (r.perms?.includes('Administrator') && !me.permissions.has(P.Administrator)) perms.length = 0;
      if (opts.preview) { report.created.roles.push(r.name); continue; }
      role = await guild.roles.create({
        name: r.name, color: r.color || undefined, hoist: !!r.hoist, mentionable: false,
        permissions: perms, reason: 'PlayCode /setup',
      });
      report.created.roles.push(r.name);
    }
    roleIds[r.key] = role.id;
  }
  if (!opts.preview && roleIds.owner) {
    const ownerRole = guild.roles.cache.get(roleIds.owner);
    const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
    if (ownerRole && owner && !owner.roles.cache.has(ownerRole.id)) {
      if (ownerRole.position < me.roles.highest.position) await owner.roles.add(ownerRole, 'PlayCode /setup: server owner').catch(() => {});
      else report.warnings.push('Move my role above Studio Owner so I can give it to the server owner.');
    }
  }

  // 2. Who's who, for permissions.
  const ids = (keys) => keys.map((k) => roleIds[k]).filter(Boolean);
  const ctx = {
    everyone: guild.roles.everyone.id,
    verified: opts.verification === 'off' ? null : roleIds.verified,
    staff: ids(STAFF_KEYS),
    team: ids(TEAM_KEYS.filter((k) => !STAFF_KEYS.includes(k))),
    members: ids(['verified', 'creator', ...TEAM_KEYS.filter((k) => !STAFF_KEYS.includes(k))]),
    botId: me.id,
    verification: opts.verification,
  };
  const dropped = new Set();
  const apply = (profile, voice) => { const g = grantable(overwritesFor(profile, ctx, { voice }), me); g.dropped.forEach((d) => dropped.add(d)); return g.list; };

  // 3. Categories and channels.
  const catIds = { ...store.get('setup', 'categories') };
  const chIds = { ...store.get('setup', 'channels') };
  const community = guild.features.includes('COMMUNITY');
  const catProfile = { catStart: null, catNews: 'chat', catCommunity: 'chat', catSupport: 'chat', catVoice: 'chat', catTeam: 'team', catStaff: 'staff', catTickets: 'hidden' };

  for (const cat of CATEGORIES) {
    progress(`Category ${cat.name}`);
    let category = catIds[cat.key] && guild.channels.cache.get(catIds[cat.key]);
    let catAdopted = false;
    if (!category) {
      category = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && norm(c.name) === norm(cat.name));
      if (category) { catAdopted = true; report.adopted.categories.push(cat.name); }
    }
    const profile = cat.profile || catProfile[cat.key];
    if (!category) {
      report.created.categories.push(cat.name);
      if (!opts.preview) {
        category = await guild.channels.create({
          name: cat.name, type: ChannelType.GuildCategory,
          permissionOverwrites: profile ? apply(profile, true) : [], reason: 'PlayCode /setup',
        });
      }
    } else if ((opts.fixPermissions || catAdopted) && profile && !opts.preview) {
      // Existing categories PlayCode takes over get the studio permissions; ones it already manages are left as you've tuned them.
      await category.permissionOverwrites.set(apply(profile, true), 'PlayCode /setup');
      report.repaired.push(category.name);
    }
    if (category) catIds[cat.key] = category.id;

    for (const ch of cat.channels) {
      if (ch.needsVerification && opts.verification === 'off') continue;
      const type = ch.voice ? ChannelType.GuildVoice : (ch.announcement && community ? ChannelType.GuildAnnouncement : ChannelType.GuildText);
      const sameKind = (c) => (ch.voice ? c.type === ChannelType.GuildVoice : [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type));
      let channel = chIds[ch.key] && guild.channels.cache.get(chIds[ch.key]);
      let adopted = false;
      if (!channel) {
        const matches = guild.channels.cache.filter((c) => sameKind(c) && norm(c.name) === norm(ch.name));
        channel = matches.find((c) => category && c.parentId === category.id) || matches.first();
        // Don't adopt a channel another blueprint key already owns.
        if (channel && Object.values(chIds).includes(channel.id)) channel = null;
        if (channel) { adopted = true; report.adopted.channels.push(`#${channel.name}`); }
      }
      if (!channel) {
        report.created.channels.push(ch.voice ? `🔊 ${ch.name}` : `#${ch.name}`);
        if (opts.preview) continue;
        channel = await guild.channels.create({
          name: ch.name, type, parent: category?.id, topic: ch.voice ? undefined : ch.topic,
          permissionOverwrites: apply(ch.profile, !!ch.voice), reason: 'PlayCode /setup',
        });
      } else if (!opts.preview) {
        if (category && channel.parentId !== category.id) await channel.setParent(category.id, { lockPermissions: false, reason: 'PlayCode /setup' }).catch(() => {});
        if (opts.fixPermissions || adopted) {
          await channel.permissionOverwrites.set(apply(ch.profile, !!ch.voice), 'PlayCode /setup');
          report.repaired.push(`#${channel.name}`);
        }
      }
      chIds[ch.key] = channel.id;
    }
  }
  // Clean up channels older versions made: only inside the right category, only if nobody has posted.
  // Forget channel keys that aren't in the blueprint anymore, so only current channels count as wanted.
  const blueprintKeys = new Set(CATEGORIES.flatMap((c) => c.channels.map((x) => x.key)));
  for (const k of Object.keys(chIds)) if (!blueprintKeys.has(k)) delete chIds[k];
  const wanted = new Set(Object.values(chIds));
  for (const r of RETIRED) {
    const parentId = catIds[r.category];
    if (!parentId) continue;
    const names = new Set(r.names.map(norm));
    const old = guild.channels.cache.filter((c) => c.parentId === parentId && !wanted.has(c.id) && names.has(norm(c.name)));
    for (const ch of old.values()) {
      if (opts.preview) { report.removed.push(`#${ch.name}`); continue; }
      const recent = ch.messages?.fetch ? await ch.messages.fetch({ limit: 10 }).catch(() => null) : null;
      const used = recent && [...recent.values()].some((m) => !m.author?.bot);
      if (used) { report.warnings.push(`Kept #${ch.name} because people have posted in it. Delete it by hand if you don't need it.`); continue; }
      await ch.delete('PlayCode /setup: channel no longer in the layout').then(() => report.removed.push(`#${ch.name}`)).catch((e) => report.warnings.push(`Couldn't delete #${ch.name}: ${e.message}`));
    }
  }
  if (dropped.size) report.warnings.push(`Some permissions were left out because my role doesn't have them: ${[...dropped].map(permName).join(', ')}.`);

  if (opts.preview) return report;

  // 4. Save before posting panels, so a panel failure never loses the layout.
  store.update((d) => {
    Object.assign(d.setup, { done: true, studioName: opts.studioName, roles: roleIds, categories: catIds, channels: chIds, ranAt: new Date().toISOString() });
    d.settings.verification = opts.verification;
  });

  // 5. Panels: posted once, edited in place on later runs.
  if (opts.postPanels) {
    progress('Panels');
    const wanted = [
      ['welcome', 'welcome', panels.welcomePanel],
      ['rules', 'rules', panels.rulesPanel],
      ['verify', 'verify', panels.verifyPanel],
      ['roles', 'roles', panels.rolesPanel],
      ['tickets', 'support', panels.ticketPanel],
    ];
    for (const [panelKey, channelKey, build] of wanted) {
      if (panelKey === 'verify' && opts.verification === 'off') continue;
      try {
        const posted = await panels.postOrEdit(guild, store, panelKey, channelKey, build(store, guild));
        if (posted) report.panels.push(`${panelKey} → <#${posted.channelId}>`);
      } catch (e) {
        report.warnings.push(`Couldn't post the ${panelKey} panel: ${e.message}`);
      }
    }
  }
  return report;
}

module.exports = { runSetup, overwritesFor, grantable };
