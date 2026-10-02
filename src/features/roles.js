'use strict';
// Self-assign ping roles from the #roles menu.
const { ROLES } = require('../setup/blueprint');
const { respond } = require('../lib/util');

const PING_KEYS = ROLES.filter((r) => r.group === 'ping').map((r) => r.key);

async function handle(interaction, { store }) {
  const [, , action] = interaction.customId.split(':');
  const member = interaction.member;
  const all = PING_KEYS.map((k) => store.roleId(k)).filter(Boolean);
  if (!all.length) return respond(interaction, 'Ping roles aren\'t set up yet. Ask staff to run /setup.');

  const chosen = action === 'select' ? interaction.values.filter((v) => PING_KEYS.includes(v)).map((k) => store.roleId(k)).filter(Boolean) : [];
  const add = chosen.filter((id) => !member.roles.cache.has(id));
  const remove = all.filter((id) => !chosen.includes(id) && member.roles.cache.has(id));
  try {
    if (add.length) await member.roles.add(add, 'Ping role menu');
    if (remove.length) await member.roles.remove(remove, 'Ping role menu');
  } catch {
    return respond(interaction, 'I couldn\'t change your roles. My role needs to be above the ping roles; let staff know.');
  }
  // Reset the shared menu so it doesn't look stuck on this person's picks.
  if (action === 'select') await interaction.message.edit({ components: interaction.message.components }).catch(() => {});
  const names = chosen.map((id) => `<@&${id}>`);
  return respond(interaction, { content: names.length ? `You'll be pinged for: ${names.join(', ')}` : 'All pings removed.', allowedMentions: { parse: [] } });
}

module.exports = { handle, PING_KEYS };
