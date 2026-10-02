'use strict';
// Member join/leave: welcome message and join/leave logs. Roblox verification is RoVer's job.
const { embed, modLog, sendTo, ts } = require('../lib/util');

async function onJoin(member, { store }) {
  if (member.guild.id !== store.guildId) return;
  const mode = store.get('settings', 'verification') === 'off' ? 'off' : 'rover';
  const verifiedId = store.roleId('verified');
  // Verification off: everyone is a member straight away. Otherwise RoVer gives Verified.
  if (verifiedId && mode === 'off' && store.get('settings', 'autoRoleOnJoin') !== false) {
    await member.roles.add(verifiedId, 'Auto role on join').catch(() => {});
  }

  if (store.get('settings', 'welcomeEnabled') !== false) {
    const verify = store.channelId('verify');
    const roles = store.channelId('roles');
    const next = mode !== 'off' && verify ? `Head to <#${verify}> and use \`/verify\` to unlock the server.` : roles ? `Grab your pings in <#${roles}>.` : '';
    await sendTo(member.guild, store, 'welcome', {
      content: `${member}`,
      embeds: [embed().setDescription(`👋 Welcome to **${store.get('setup', 'studioName') || member.guild.name}**, ${member}! ${next}`).setFooter({ text: `Member #${member.guild.memberCount}` })],
      allowedMentions: { users: [member.id] },
    });
  }

  const ageDays = (Date.now() - member.user.createdTimestamp) / 86400e3;
  await modLog(member.guild, store, {
    embeds: [embed('ok').setAuthor({ name: `${member.user.tag} joined`, iconURL: member.user.displayAvatarURL() })
      .setDescription(`${member} · account created ${ts(member.user.createdAt, 'R')}${ageDays < 7 ? ' ⚠️ **new account**' : ''}`)
      .setFooter({ text: `ID ${member.id}` }).setTimestamp()],
  });
}

async function onLeave(member, { store }) {
  if (member.guild.id !== store.guildId) return;
  const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => r.toString()) || [];
  await modLog(member.guild, store, {
    embeds: [embed('muted').setAuthor({ name: `${member.user?.tag || member.id} left`, iconURL: member.user?.displayAvatarURL?.() })
      .setDescription(`<@${member.id}>${member.joinedAt ? ` · joined ${ts(member.joinedAt, 'R')}` : ''}${roles.length ? `\nRoles: ${roles.join(' ').slice(0, 900)}` : ''}`)
      .setFooter({ text: `ID ${member.id}` }).setTimestamp()],
  });
}

module.exports = { onJoin, onLeave };
