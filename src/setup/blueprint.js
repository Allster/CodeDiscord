'use strict';
// The server layout /setup builds. Edit names, colours and channels here; the bot tracks everything
// by ID after the first run, so renaming things in Discord later is safe.
//
// Access profiles (who can see/talk in a channel):
//   public      everyone can read, nobody but staff and the bot can post
//   gate        the verify channel: visible to unverified people, hidden once they're Verified
//   news        members can read, only staff/bot post (members can react and use threads)
//   chat        members can read and talk
//   botfeed     members can read and react, only the bot posts (bug reports, suggestions)
//   team        studio team (dev roles + staff) only
//   staff       staff only
//   hidden      staff only, used as the parent for ticket channels
// "members" means anyone with Verified or any team/staff role. With verification off, @everyone counts.

const ROLES = [
  // key            name                 colour     group      hoist
  { key: 'owner',     name: 'Studio Owner',     color: 0xf5b301, group: 'staff', hoist: true, perms: ['Administrator'] },
  { key: 'lead',      name: 'Lead Developer',   color: 0xff6b3d, group: 'staff', hoist: true, perms: ['ManageChannels', 'ManageMessages', 'ManageThreads', 'ManageEvents', 'ManageNicknames', 'ModerateMembers', 'KickMembers', 'MentionEveryone', 'ViewAuditLog'] },
  { key: 'moderator', name: 'Moderator',        color: 0x3ba55d, group: 'staff', hoist: true, perms: ['ManageMessages', 'ManageThreads', 'ManageNicknames', 'ModerateMembers', 'KickMembers', 'ViewAuditLog'] },
  { key: 'scripter',  name: 'Scripter',         color: 0x5865f2, group: 'team',  hoist: true },
  { key: 'builder',   name: 'Builder',          color: 0x2ecc71, group: 'team',  hoist: true },
  { key: 'modeler',   name: 'Modeler',          color: 0x1abc9c, group: 'team',  hoist: true },
  { key: 'ui',        name: 'UI Designer',      color: 0xe91e63, group: 'team',  hoist: true },
  { key: 'animator',  name: 'Animator',         color: 0x9b59b6, group: 'team',  hoist: true },
  { key: 'audio',     name: 'Audio & SFX',      color: 0xe67e22, group: 'team',  hoist: true },
  { key: 'tester',    name: 'QA Tester',        color: 0x95a5a6, group: 'team',  hoist: true },
  { key: 'creator',   name: 'Content Creator',  color: 0xff4757, group: 'member', hoist: false },
  { key: 'verified',  name: 'Verified',         color: 0x99aab5, group: 'member', hoist: false },
  // Ping roles: members pick these themselves from the #roles menu.
  { key: 'pingUpdates',   name: 'Update Ping',   color: 0, group: 'ping', description: 'Game updates and patch notes', emoji: '🚀' },
  { key: 'pingDevlogs',   name: 'Devlog Ping',   color: 0, group: 'ping', description: 'Behind-the-scenes devlogs and sneak peeks', emoji: '🛠️' },
  { key: 'pingPlaytests', name: 'Playtest Ping', color: 0, group: 'ping', description: 'Invites to test new builds', emoji: '🧪' },
  { key: 'pingEvents',    name: 'Event Ping',    color: 0, group: 'ping', description: 'Community events and giveaways', emoji: '🎉' },
];

const CATEGORIES = [
  {
    key: 'catStart', name: 'START HERE', channels: [
      { key: 'welcome', name: 'welcome', profile: 'public', topic: 'Welcome to the studio! New members are greeted here.' },
      { key: 'rules', name: 'rules', profile: 'public', topic: 'Read these before chatting.' },
      { key: 'verify', name: 'verify', profile: 'gate', topic: 'Verify to unlock the rest of the server.', needsVerification: true },
      { key: 'roles', name: 'roles', profile: 'news', topic: 'Pick which pings you want.' },
    ],
  },
  {
    key: 'catNews', name: 'NEWS', channels: [
      { key: 'announcements', name: 'announcements', profile: 'news', announcement: true, topic: 'Studio announcements.' },
      { key: 'updates', name: 'game-updates', profile: 'news', announcement: true, topic: 'Patch notes and update logs.' },
      { key: 'devlogs', name: 'devlogs', profile: 'news', topic: 'Devlogs and sneak peeks from the team.' },
      { key: 'playtests', name: 'playtests', profile: 'news', topic: 'Upcoming playtests. Grab the Playtest Ping role in #roles.' },
    ],
  },
  {
    key: 'catCommunity', name: 'COMMUNITY', channels: [
      { key: 'general', name: 'general', profile: 'chat', topic: 'Talk about anything (keep it friendly).' },
      { key: 'media', name: 'media', profile: 'chat', topic: 'Screenshots, clips and fan art.' },
      { key: 'offtopic', name: 'off-topic', profile: 'chat' },
      { key: 'suggestions', name: 'suggestions', profile: 'botfeed', topic: 'Use /suggest to post an idea. Vote with the buttons.' },
      { key: 'bugReports', name: 'bug-reports', profile: 'botfeed', topic: 'Use /bug to report a bug. One report per bug, please.' },
      { key: 'botCommands', name: 'bot-commands', profile: 'chat', topic: 'Use bot commands here.' },
    ],
  },
  {
    key: 'catSupport', name: 'SUPPORT', channels: [
      { key: 'support', name: 'support', profile: 'news', topic: 'Open a private ticket with the buttons below.' },
    ],
  },
  {
    key: 'catTeam', name: 'STUDIO TEAM', channels: [
      { key: 'teamChat', name: 'team-chat', profile: 'team', topic: 'Studio team chat.' },
      { key: 'tasks', name: 'tasks', profile: 'team', topic: 'What everyone is working on.' },
    ],
  },
  {
    key: 'catStaff', name: 'STAFF', channels: [
      { key: 'staffChat', name: 'staff-chat', profile: 'staff' },
      { key: 'modLog', name: 'mod-log', profile: 'staff', topic: 'Moderation actions, joins/leaves and ticket transcripts.' },
      { key: 'applications', name: 'applications', profile: 'staff', topic: 'Team applications from tickets land here.' },
    ],
  },
  {
    key: 'catVoice', name: 'VOICE', channels: [
      { key: 'vcLounge', name: 'Lounge', profile: 'chat', voice: true },
      { key: 'vcPlaytest', name: 'Playtest', profile: 'chat', voice: true },
      { key: 'vcMeeting', name: 'Dev Meeting', profile: 'team', voice: true },
      { key: 'vcStaff', name: 'Staff', profile: 'staff', voice: true },
    ],
  },
  { key: 'catTickets', name: 'TICKETS', profile: 'hidden', channels: [] },
];

// Channels older versions of /setup made that are no longer wanted. /setup deletes these, but only when
// they're inside the STUDIO TEAM category and nobody has posted in them, so nothing real is lost.
const RETIRED = [
  { category: 'catTeam', names: ['scripting', 'building', 'modeling', 'ui-design', 'animation', 'audio', 'assets', 'playtest-notes', 'git-feed'] },
];

const RULES = [
  ['Be respectful', 'No harassment, hate speech, slurs or personal attacks. Disagree with ideas, not people.'],
  ['Keep it safe', 'No NSFW, gore or shock content anywhere, including names and avatars.'],
  ['No spam or self-promo', 'No advertising other servers, games or socials unless staff say it\'s fine.'],
  ['No exploits or leaks', 'Don\'t share exploits, cheats or unreleased studio content. Report bugs with /bug instead.'],
  ['No scams', 'No trading Robux, accounts or limiteds here. Staff will never ask for your password.'],
  ['Use the right channels', 'Bugs go in /bug, ideas in /suggest, help in a ticket.'],
  ['Follow Discord and Roblox rules', 'Discord\'s Terms and Community Guidelines and Roblox\'s Community Standards apply here too.'],
  ['Staff have the final say', 'If a mod asks you to stop, stop. Disagree with a decision? Open a ticket.'],
];

module.exports = { ROLES, CATEGORIES, RULES, RETIRED };
