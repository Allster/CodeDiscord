'use strict';
// Admin commands: /setup, /panel, /config.
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType } = require('discord.js');
const { runSetup } = require('../setup/runSetup');
const panels = require('../setup/panels');
const { ROLES, CATEGORIES } = require('../setup/blueprint');
const { embed, isAdmin, respond, clip, EPHEMERAL } = require('../lib/util');

const CHANNEL_KEYS = CATEGORIES.flatMap((c) => c.channels.map((ch) => ({ key: ch.key, name: ch.name, voice: !!ch.voice })));
const ROLE_KEYS = ROLES.map((r) => ({ key: r.key, name: r.name }));
const SETTINGS = {
  welcomeEnabled: 'Welcome messages',
  staffApplicationsOpen: 'Team applications open',
  autoRoleOnJoin: 'Give Verified on join (when verification is off)',
};

const list = (arr, max = 800) => (arr.length ? clip(arr.join(', '), max) : '—');

function reportEmbed(r) {
  const title = r.preview ? 'Setup preview (nothing changed)' : 'Setup finished';
  const e = embed(r.preview ? 'info' : 'ok').setTitle(title)
    .setDescription(`Studio: **${r.opts.studioName}** · Verification: **${r.opts.verification === 'off' ? 'off' : 'RoVer'}**`)
    .addFields(
      { name: r.preview ? 'Would create roles' : 'Created roles', value: list(r.created.roles), inline: false },
      { name: r.preview ? 'Would create channels' : 'Created channels', value: list([...r.created.categories.map((c) => `📁 ${c}`), ...r.created.channels]), inline: false },
    );
  const adopted = [...r.adopted.roles.map((x) => `@${x}`), ...r.adopted.categories.map((c) => `📁 ${c}`), ...r.adopted.channels];
  if (adopted.length) e.addFields({ name: r.preview ? 'Would reuse existing' : 'Reused existing', value: list(adopted) });
  if (r.removed.length) e.addFields({ name: r.preview ? 'Would remove old channels' : 'Removed old channels', value: list(r.removed) });
  if (r.repaired.length) e.addFields({ name: 'Permissions applied to', value: list(r.repaired) });
  if (r.panels.length) e.addFields({ name: 'Panels', value: r.panels.join('\n') });
  if (r.warnings.length) e.addFields({ name: 'Heads up', value: clip(r.warnings.map((w) => `• ${w}`).join('\n'), 900) });
  if (!r.preview) e.addFields({ name: 'Next', value: '• Drag my role near the top of Server Settings → Roles so I can manage everything.\n• Give your team their roles (Scripter, Builder…).\n• Try `/help` to see everything I do.' });
  return e;
}

const setup = {
  // One command, no options: builds everything with the defaults (server name, RoVer verification gate,
  // all panels). Run it again any time to repair missing roles, channels or panels.
  data: new SlashCommandBuilder().setName('setup').setDescription('Set up the whole studio server automatically: roles, channels, permissions and panels.')
    .setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false),
  async execute(interaction, ctx) {
    if (!isAdmin(interaction.member, ctx.config)) return respond(interaction, 'Only the server owner or admins can run /setup.');
    await interaction.deferReply({ flags: EPHEMERAL });
    return build(interaction, ctx, { postPanels: true });
  },
};

async function build(interaction, ctx, options) {
  let last = 0;
  const progress = (step) => {
    if (Date.now() - last < 1500) return;
    last = Date.now();
    interaction.editReply({ content: `⚙️ Setting up… ${step}`, embeds: [], components: [] }).catch(() => {});
  };
  try {
    const report = await runSetup({ guild: interaction.guild, store: ctx.store, options, progress });
    await new Promise((r) => setTimeout(r, 300));
    return interaction.editReply({ content: '', embeds: [reportEmbed(report)], components: [] });
  } catch (e) {
    console.error('[setup]', e);
    return interaction.editReply({ content: e.friendly ? `❌ ${e.message}` : `❌ Setup stopped: ${e.message}\nAnything already made is kept; fix the problem and run /setup again to finish.`, embeds: [], components: [] });
  }
}

// Old preview buttons (from earlier versions) just point people back to /setup.
async function handleSetupButton(interaction) {
  return interaction.update({ content: 'Just run /setup. It does everything in one go now.', embeds: [], components: [] });
}

const panel = {
  data: new SlashCommandBuilder().setName('panel').setDescription('Re-post or refresh one of the setup panels.')
    .setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addStringOption((o) => o.setName('which').setDescription('Which panel').setRequired(true)
      .addChoices({ name: 'All', value: 'all' }, ...Object.keys(panels.PANELS).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), value: k }))))
    .addChannelOption((o) => o.setName('channel').setDescription('Post it here instead (moves the panel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  async execute(interaction, ctx) {
    if (!isAdmin(interaction.member, ctx.config)) return respond(interaction, 'Only admins can do that.');
    if (!ctx.store.get('setup', 'done')) return respond(interaction, 'Run /setup first.');
    await interaction.deferReply({ flags: EPHEMERAL });
    const which = interaction.options.getString('which', true);
    const target = interaction.options.getChannel('channel');
    const keys = which === 'all' ? Object.keys(panels.PANELS) : [which];
    const done = [];
    for (const k of keys) {
      const p = panels.PANELS[k];
      if (k === 'verify' && ctx.store.get('settings', 'verification') === 'off') continue;
      if (target && which !== 'all') ctx.store.update((d) => { d.setup.channels[p.channel] = target.id; });
      const msg = await panels.postOrEdit(interaction.guild, ctx.store, k, p.channel, p.build(ctx.store, interaction.guild)).catch((e) => ({ error: e.message }));
      done.push(msg?.error ? `❌ ${k}: ${msg.error}` : msg ? `✅ ${k} → ${msg.url}` : `⚠️ ${k}: channel missing`);
    }
    return interaction.editReply(done.join('\n') || 'Nothing to post.');
  },
};

const configCmd = {
  data: new SlashCommandBuilder().setName('config').setDescription('View or change PlayCode settings.')
    .setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
    .addSubcommand((s) => s.setName('view').setDescription('Show the current setup'))
    .addSubcommand((s) => s.setName('channel').setDescription('Point a feature at a different channel')
      .addStringOption((o) => o.setName('feature').setDescription('Which channel').setRequired(true).setAutocomplete(true))
      .addChannelOption((o) => o.setName('channel').setDescription('The channel to use').setRequired(true)))
    .addSubcommand((s) => s.setName('role').setDescription('Point a feature at a different role')
      .addStringOption((o) => o.setName('feature').setDescription('Which role').setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName('role').setDescription('The role to use').setRequired(true)))
    .addSubcommand((s) => s.setName('toggle').setDescription('Turn a setting on or off')
      .addStringOption((o) => o.setName('setting').setDescription('Setting').setRequired(true).addChoices(...Object.entries(SETTINGS).map(([value, name]) => ({ name, value }))))
      .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true))),
  async autocomplete(interaction) {
    const sub = interaction.options.getSubcommand();
    const q = interaction.options.getFocused().toLowerCase();
    const src = sub === 'role' ? ROLE_KEYS : CHANNEL_KEYS;
    return interaction.respond(src.filter((x) => x.name.toLowerCase().includes(q) || x.key.toLowerCase().includes(q)).slice(0, 25).map((x) => ({ name: x.name, value: x.key })));
  },
  async execute(interaction, ctx) {
    const { store } = ctx;
    if (!isAdmin(interaction.member, ctx.config)) return respond(interaction, 'Only admins can change settings.');
    const sub = interaction.options.getSubcommand();
    if (sub === 'view') {
      const s = store.get('setup');
      const ch = CHANNEL_KEYS.filter((c) => s.channels[c.key]).map((c) => `${c.name}: <#${s.channels[c.key]}>`);
      const rl = ROLE_KEYS.filter((r) => s.roles[r.key]).map((r) => `<@&${s.roles[r.key]}>`);
      const st = Object.entries(SETTINGS).map(([k, n]) => `${store.get('settings', k) === false ? '⬜' : '✅'} ${n}`);
      return respond(interaction, {
        embeds: [embed('info').setTitle(`${s.studioName || interaction.guild.name} · PlayCode`)
          .setDescription(s.done ? `Set up ${s.ranAt ? `<t:${Math.floor(new Date(s.ranAt) / 1000)}:R>` : ''} · verification: **${store.get('settings', 'verification') === 'off' ? 'off' : 'RoVer'}**` : 'Not set up yet. Run **/setup**.')
          .addFields({ name: 'Settings', value: st.join('\n') }, { name: 'Roles', value: clip(rl.join(' ') || '—', 1024) }, { name: 'Channels', value: clip(ch.join('\n') || '—', 1024) })],
        allowedMentions: { parse: [] },
      });
    }
    if (sub === 'channel') {
      const key = interaction.options.getString('feature', true);
      if (!CHANNEL_KEYS.some((c) => c.key === key)) return respond(interaction, 'Pick a channel from the list.');
      const channel = interaction.options.getChannel('channel', true);
      store.update((d) => { d.setup.channels[key] = channel.id; });
      return respond(interaction, `Done: **${CHANNEL_KEYS.find((c) => c.key === key).name}** now uses ${channel}.`);
    }
    if (sub === 'role') {
      const key = interaction.options.getString('feature', true);
      if (!ROLE_KEYS.some((r) => r.key === key)) return respond(interaction, 'Pick a role from the list.');
      const role = interaction.options.getRole('role', true);
      store.update((d) => { d.setup.roles[key] = role.id; });
      return respond(interaction, { content: `Done: **${ROLE_KEYS.find((r) => r.key === key).name}** is now ${role}.`, allowedMentions: { parse: [] } });
    }
    if (sub === 'toggle') {
      const key = interaction.options.getString('setting', true);
      const on = interaction.options.getBoolean('on', true);
      store.update((d) => { d.settings[key] = on; });
      if (key === 'staffApplicationsOpen') await panels.postOrEdit(interaction.guild, store, 'tickets', 'support', panels.ticketPanel(store)).catch(() => {});
      return respond(interaction, `${SETTINGS[key]}: **${on ? 'on' : 'off'}**`);
    }
    return null;
  },
};

module.exports = { commands: [setup, panel, configCmd], handleSetupButton };
