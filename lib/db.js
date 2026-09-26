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
module.exports = {
  query: (text, params) => getPool().query(text, params)
};
