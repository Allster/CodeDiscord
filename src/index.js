'use strict';
// PlayCode: a single-server Discord bot for a Roblox game studio.
const http = require('http');
const { Client, GatewayIntentBits, Partials, Events, REST, Routes, ActivityType } = require('discord.js');
const { config, assertConfig } = require('./config');
const { Store } = require('./lib/store');
const { respond } = require('./lib/util');
const admin = require('./commands/admin');
const moderation = require('./commands/moderation');
const community = require('./commands/community');
const roles = require('./features/roles');
const tickets = require('./features/tickets');
const feedback = require('./features/feedback');
const posts = require('./features/posts');
const playtests = require('./features/playtests');
const members = require('./features/members');

const COMMANDS = [...admin.commands, ...moderation.commands, ...community.commands];
const byName = new Map(COMMANDS.map((c) => [c.data.name, c]));

// customId "pc:<feature>:…" → handler
const COMPONENTS = {
  setup: admin.handleSetupButton,
  roles: roles.handle,
  ticket: tickets.handle,
  bug: feedback.handle,
  sug: feedback.handle,
  post: posts.handle,
  pt: playtests.handle,
};

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  // Guild commands update instantly. Clear any old global ones so nothing shows up twice.
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: COMMANDS.map((c) => c.data.toJSON()) });
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] }).catch(() => {});
  console.log(`[commands] Registered ${COMMANDS.length} commands in ${config.guildId}`);
}

function start() {
  assertConfig();
  const store = new Store(config.dataDir);
  store.guildId = config.guildId;
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember],
  });
  const ctx = { client, store, config };

  client.once(Events.ClientReady, async (c) => {
    const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
    console.log(`[ready] Logged in as ${c.user.tag} · PlayCode ${require('../package.json').version}${commit ? ` · commit ${commit}` : ''}`);
    const home = c.guilds.cache.get(config.guildId);
    const others = c.guilds.cache.filter((g) => g.id !== config.guildId);
    if (home) {
      console.log(`[guard] Home server: ${home.name} (${home.id})`);
      if (config.leaveOtherGuilds) for (const g of others.values()) { console.log(`[guard] Leaving ${g.name} (${g.id}), not the home server`); await g.leave().catch(() => {}); }
    } else {
      // Never leave anything while the home server is missing: GUILD_ID is probably wrong.
      console.warn(`[guard] I'm not in GUILD_ID ${config.guildId}. ${others.size ? `I'm in: ${others.map((g) => `${g.name} = ${g.id}`).join(', ')}. If that's your server, set GUILD_ID to that number and redeploy.` : 'I\'m not in any server yet.'}`);
      console.warn(`[guard] Invite link: https://discord.com/oauth2/authorize?client_id=${c.user.id}&scope=bot+applications.commands&permissions=8&guild_id=${config.guildId}&disable_guild_select=true`);
    }
    try { await registerCommands(); } catch (e) { console.error('[commands] Registration failed:', e.message); }
    c.user.setPresence({ activities: [{ name: store.get('setup', 'studioName') ? `${store.get('setup', 'studioName')} · /help` : '/help', type: ActivityType.Watching }], status: 'online' });
    setInterval(() => {
      const g = c.guilds.cache.get(config.guildId);
      if (g) playtests.tick(g, store).catch((e) => console.error('[playtests]', e.message));
    }, 30e3).unref();
  });

  client.on(Events.GuildCreate, async (guild) => {
    if (guild.id === config.guildId) { console.log(`[guard] Joined home server ${guild.name}. Run /setup there.`); registerCommands().catch((e) => console.error('[commands]', e.message)); return; }
    // Only leave other servers once the home server is confirmed, so a wrong GUILD_ID can't lock you out.
    if (!client.guilds.cache.has(config.guildId)) {
      console.warn(`[guard] Added to ${guild.name} (${guild.id}), but GUILD_ID is ${config.guildId}. Staying. If this is your studio server, set GUILD_ID=${guild.id} and redeploy.`);
      return;
    }
    if (config.leaveOtherGuilds) { console.log(`[guard] Added to ${guild.name} (${guild.id}); not the home server, leaving.`); await guild.leave().catch(() => {}); }
  });

  client.on(Events.GuildMemberAdd, (m) => members.onJoin(m, ctx).catch((e) => console.error('[join]', e.message)));
  client.on(Events.GuildMemberRemove, (m) => members.onLeave(m, ctx).catch((e) => console.error('[leave]', e.message)));

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.guildId !== config.guildId) {
      if (interaction.isRepliable()) await respond(interaction, 'I only work in my studio\'s server.');
      return;
    }
    try {
      if (interaction.isAutocomplete()) {
        const cmd = byName.get(interaction.commandName);
        if (cmd?.autocomplete) await cmd.autocomplete(interaction, ctx);
        return;
      }
      if (interaction.isChatInputCommand()) {
        const cmd = byName.get(interaction.commandName);
        if (!cmd) return respond(interaction, 'That command isn\'t available anymore.');
        await cmd.execute(interaction, ctx);
        return;
      }
      if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
        const [ns, feature] = interaction.customId.split(':');
        const handler = ns === 'pc' && COMPONENTS[feature];
        if (handler) await handler(interaction, ctx);
      }
    } catch (e) {
      console.error(`[interaction] ${interaction.commandName || interaction.customId}:`, e);
      const msg = e.friendly ? e.message : e.code === 50013 ? 'I\'m missing a permission for that. Check that my role is high enough and has the right permissions.' : 'Something went wrong. Try again, and tell staff if it keeps happening.';
      if (interaction.isRepliable()) {
        if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: `❌ ${msg}`, embeds: [], components: [] }).catch(() => {});
        else await respond(interaction, `❌ ${msg}`);
      }
    }
  });

  // Optional health check for hosts that want an open port (Render, Fly…). Railway doesn't need it.
  if (process.env.PORT) {
    http.createServer((req, res) => { res.writeHead(client.isReady() ? 200 : 503, { 'content-type': 'text/plain' }); res.end(client.isReady() ? 'ok' : 'starting'); })
      .listen(Number(process.env.PORT), () => console.log(`[health] Listening on ${process.env.PORT}`));
  }

  const shutdown = (sig) => { console.log(`[exit] ${sig}`); try { store.flush(); } catch {} client.destroy().finally(() => process.exit(0)); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

  return client.login(config.token);
}

if (require.main === module) {
  Promise.resolve().then(start).catch((e) => {
    console.error(`[fatal] ${e.message}${e.code === 'TokenInvalid' ? ' Check DISCORD_TOKEN.' : ''}`);
    process.exit(1);
  });
}

module.exports = { COMMANDS, COMPONENTS, start };
