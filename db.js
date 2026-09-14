const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for Red Dawn Bot v5 multi-server mode.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS red_dawn_guilds (
      guild_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      config_enc TEXT NOT NULL,
      stats_enc TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS red_dawn_guilds_updated_idx ON red_dawn_guilds(updated_at);`);
}

async function getGuild(guildId) {
  const { rows } = await pool.query(
    'SELECT guild_id, owner_id, config_enc, stats_enc FROM red_dawn_guilds WHERE guild_id = $1',
    [guildId]
  );
  return rows[0] || null;
}

async function saveGuild({ guildId, ownerId, configEnc, statsEnc }) {
  await pool.query(`
    INSERT INTO red_dawn_guilds (guild_id, owner_id, config_enc, stats_enc)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      config_enc = EXCLUDED.config_enc,
      stats_enc = EXCLUDED.stats_enc,
      updated_at = NOW()
  `, [guildId, ownerId, configEnc, statsEnc]);
}

async function listGuilds() {
  const { rows } = await pool.query('SELECT guild_id, owner_id, config_enc, stats_enc FROM red_dawn_guilds');
  return rows;
}

async function closeDatabase() {
  await pool.end();
}

module.exports = { pool, initDatabase, getGuild, saveGuild, listGuilds, closeDatabase };
