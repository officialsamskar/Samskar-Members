const { Pool, types } = require('pg');
types.setTypeParser(1082, (val) => val); // DATE (oid 1082): keep as 'YYYY-MM-DD' string, no timezone conversion

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3
    });
  }
  return pool;
}
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}
module.exports = {
  query: (text, params) => getPool().query(text, params),
  tx
};
