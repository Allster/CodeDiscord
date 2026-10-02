'use strict';
// Community and studio commands: /bug, /suggest, /note, /post, /playtest, /ticket, /roblox, /help.
const { SlashCommandBuilder, PermissionFlagsBits: P, OverwriteType } = require('discord.js');
const feedback = require('../features/feedback');
const posts = require('../features/posts');
const playtests = require('../features/playtests');
const tickets = require('../features/tickets');
const roblox = require('../lib/roblox');
const { embed, isStaff, respond, ts, clip, EPHEMERAL } = require('../lib/util');

const commands = [
  {
    data: new SlashCommandBuilder().setName('bug').setDescription('Report a bug in one of our games').setDMPermission(false),
    async execute(interaction, ctx) {
      if (!ctx.store.channelId('bugReports')) return respond(interaction, 'Bug reports aren\'t set up yet.');
      return interaction.showModal(feedback.bugModal());
    },
  },
  {
    data: new SlashCommandBuilder().setName('suggest').setDescription('Suggest an idea for our games or this server').setDMPermission(false),
    async execute(interaction, ctx) {
      if (!ctx.store.channelId('suggestions')) return respond(interaction, 'Suggestions aren\'t set up yet.');
      return interaction.showModal(feedback.suggestModal());
    },
  },
  {
    data: new SlashCommandBuilder().setName('note').setDescription('Staff: add a note to a bug report or suggestion').setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
      .addStringOption((o) => o.setName('type').setDescription('Bug or suggestion').setRequired(true).addChoices({ name: 'Bug', value: 'bug' }, { name: 'Suggestion', value: 'sug' }))
      .addIntegerOption((o) => o.setName('number').setDescription('Its number (#)').setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName('text').setDescription('Note shown on the post (leave empty to remove)').setMaxLength(800)),
    async execute(interaction, ctx) {
      if (!isStaff(interaction.member, ctx.store, ctx.config)) return respond(interaction, 'Only staff can add notes.');
      const res = await feedback.setNote(interaction.guild, ctx.store, interaction.options.getString('type', true), interaction.options.getInteger('number', true), interaction.options.getString('text') || '');
      return respond(interaction, res ? 'Note updated.' : 'I can\'t find that one.');
    },
  },
  {
    data: new SlashCommandBuilder().setName('post').setDescription('Post an announcement, game update, devlog or sneak peek').setDMPermission(false)
      .addStringOption((o) => o.setName('type').setDescription('What kind of post').setRequired(true).addChoices(...Object.entries(posts.KINDS).map(([value, k]) => ({ name: k.label, value }))))
      .addAttachmentOption((o) => o.setName('image').setDescription('Image or video to include'))
      .addBooleanOption((o) => o.setName('ping').setDescription('Ping the matching ping role (default: yes)'))
      .addBooleanOption((o) => o.setName('ping_everyone').setDescription('Staff: also ping @everyone')),
    execute: posts.start,
  },
  {
    data: new SlashCommandBuilder().setName('playtest').setDescription('Schedule or cancel a playtest').setDMPermission(false)
      .addSubcommand((s) => s.setName('schedule').setDescription('Schedule a playtest and ping testers')
        .addStringOption((o) => o.setName('starts_in').setDescription('How long from now, e.g. 30m, 2h, 1d4h').setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('e.g. "Gridbloom versus mode test"').setMaxLength(100))
        .addStringOption((o) => o.setName('length').setDescription('How long it runs, e.g. 45m'))
        .addStringOption((o) => o.setName('link').setDescription('Game link (roblox.com/games/…)').setMaxLength(300))
        .addStringOption((o) => o.setName('notes').setDescription('What to test, rules, etc.').setMaxLength(1500)))
      .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a playtest')
        .addStringOption((o) => o.setName('id').setDescription('Playtest id (in the post footer)').setRequired(true))),
    async execute(interaction, ctx) {
      return interaction.options.getSubcommand() === 'cancel' ? playtests.cancel(interaction, ctx) : playtests.create(interaction, ctx);
    },
  },
  {
    data: new SlashCommandBuilder().setName('ticket').setDescription('Manage the ticket you\'re in').setDMPermission(false)
      .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
      .addSubcommand((s) => s.setName('close').setDescription('Close this ticket').addStringOption((o) => o.setName('reason').setDescription('Sent to the member').setMaxLength(300))),
    async execute(interaction, ctx) {
      const t = ctx.store.get('tickets', 'open', interaction.channelId);
      if (!t) return respond(interaction, 'Use this inside a ticket channel.');
      const staff = isStaff(interaction.member, ctx.store, ctx.config);
      const sub = interaction.options.getSubcommand();
      if (sub === 'close') {
        if (!staff && interaction.user.id !== t.userId) return respond(interaction, 'Only staff or the person who opened it can close it.');
        await interaction.reply({ content: 'Closing…' });
        return tickets.closeTicket(interaction.channel, interaction.user, ctx, interaction.options.getString('reason') || '');
      }
      if (!staff) return respond(interaction, 'Only staff can change who\'s in a ticket.');
      const user = interaction.options.getUser('member', true);
      if (sub === 'add') {
        await interaction.channel.permissionOverwrites.edit(user.id, Object.fromEntries(tickets.USER_ALLOW.map((p) => [Object.keys(P).find((k) => P[k] === p), true])), { type: OverwriteType.Member });
        return interaction.reply(`${user} was added to the ticket.`);
      }
      if (user.id === t.userId) return respond(interaction, 'That\'s who opened the ticket. Close it instead.');
      await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
      return interaction.reply({ content: `${user} was removed from the ticket.`, allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder().setName('roblox').setDescription('Look up a Roblox profile').setDMPermission(false)
      .addStringOption((o) => o.setName('username').setDescription('Roblox username').setRequired(true).setMaxLength(20)),
    async execute(interaction) {
      await interaction.deferReply();
      const found = await roblox.findUser(interaction.options.getString('username', true));
      if (!found) return interaction.editReply('No Roblox user with that name.');
      const [u, avatar] = await Promise.all([roblox.getUser(found.id), roblox.getHeadshot(found.id)]);
      return interaction.editReply({
        embeds: [embed('info').setTitle(`${u.displayName} (@${u.name})${u.hasVerifiedBadge ? ' ☑️' : ''}`).setURL(roblox.profileUrl(u.id)).setThumbnail(avatar)
          .setDescription(clip(u.description || '*No bio*', 1000))
          .addFields({ name: 'User ID', value: String(u.id), inline: true }, { name: 'Joined Roblox', value: ts(u.created, 'D'), inline: true })],
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('help').setDescription('What PlayCode can do').setDMPermission(false),
    async execute(interaction, ctx) {
      const staff = isStaff(interaction.member, ctx.store, ctx.config);
      const e = embed().setTitle('PlayCode commands').addFields(
        { name: 'Everyone', value: '`/bug` report a bug · `/suggest` share an idea · `/roblox` look up a profile · `/ticket close` close your ticket' },
        { name: 'Studio team', value: '`/post` devlogs and sneak peeks · `/playtest schedule` set up a test with RSVPs and reminders' },
      );
      if (staff) {
        e.addFields(
          { name: 'Staff', value: '`/post` announcements and game updates · `/note` add a note to a bug/suggestion · status menus on bug and suggestion posts · `/ticket add|remove`' },
          { name: 'Moderation', value: '`/warn` `/warnings` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/slowmode` `/lock` `/unlock`' },
          { name: 'Admin', value: '`/setup` build or repair the server · `/panel` re-post a panel · `/config` view and change settings' },
        );
      }
      return interaction.reply({ embeds: [e], flags: EPHEMERAL });
    },
  },
];

module.exports = { commands };
