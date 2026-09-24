const { Pool } = require('pg');
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
