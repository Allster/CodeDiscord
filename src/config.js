'use strict';
// Environment settings. Everything the bot needs to run comes from here.
require('dotenv').config({ quiet: true });

// Strip spaces and stray quotes people paste into host dashboards ("123", '123 ', etc.).
const clean = (v) => String(v ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const list = (v) => clean(v).split(',').map((s) => clean(s)).filter(Boolean);

const config = {
  token: clean(process.env.DISCORD_TOKEN).replace(/^Bot\s+/i, ''),
  clientId: clean(process.env.CLIENT_ID),
  guildId: clean(process.env.GUILD_ID),
  // Discord user IDs that can always run admin commands (/setup, /config), even before roles exist.
  ownerIds: list(process.env.OWNER_IDS),
  // Where the bot keeps its data file. On Railway, mount a volume here so it survives redeploys.
  dataDir: process.env.DATA_DIR || './data',
  // Leave any server that isn't GUILD_ID. Set to "false" to only ignore them instead.
  leaveOtherGuilds: String(process.env.LEAVE_OTHER_GUILDS ?? 'true').toLowerCase() !== 'false',
};

function assertConfig() {
  const missing = ['token', 'clientId', 'guildId'].filter((k) => !config[k]);
  if (missing.length) {
    const names = { token: 'DISCORD_TOKEN', clientId: 'CLIENT_ID', guildId: 'GUILD_ID' };
    throw new Error(`Missing environment variables: ${missing.map((k) => names[k]).join(', ')}. Copy .env.example to .env and fill them in.`);
  }
  const bad = [['CLIENT_ID', config.clientId], ['GUILD_ID', config.guildId]].filter(([, v]) => !/^\d{17,20}$/.test(v));
  if (bad.length) throw new Error(`${bad.map(([k, v]) => `${k} "${v}"`).join(' and ')} should be just the long number Discord gives you (17-20 digits).`);
}

module.exports = { config, assertConfig };
