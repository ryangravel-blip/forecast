const snowflake = require('snowflake-sdk');

snowflake.configure({ logLevel: 'WARN' });

const REQUIRED_ENV = [
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USERNAME',
  'SNOWFLAKE_PRIVATE_KEY',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
];

let _conn = null;

function connect() {
  if (_conn) return Promise.resolve(_conn);

  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    return Promise.reject(new Error(`Missing env vars: ${missing.join(', ')}`));
  }

  const privateKey = process.env.SNOWFLAKE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const passphrase  = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE || undefined;

  const conn = snowflake.createConnection({
    account:       process.env.SNOWFLAKE_ACCOUNT,
    username:      process.env.SNOWFLAKE_USERNAME,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey,
    ...(passphrase ? { privateKeyPass: passphrase } : {}),
    warehouse:     process.env.SNOWFLAKE_WAREHOUSE,
    role:          process.env.SNOWFLAKE_ROLE,
    application:   'mrp-reports',
  });

  return new Promise((resolve, reject) => {
    conn.connect((err, c) => {
      if (err) { reject(err); return; }
      _conn = c;
      resolve(c);
    });
  });
}

function runQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve(rows);
      },
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { sql } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'Missing sql' });

  const first = sql.trim().toUpperCase().slice(0, 4);
  if (first !== 'SELE' && first !== 'WITH') {
    return res.status(403).json({ error: 'Only SELECT queries permitted' });
  }

  try {
    const conn = await connect();
    const rows  = await runQuery(conn, sql);
    res.status(200).json({ rows: rows ?? [] });
  } catch (err) {
    _conn = null;
    console.error('Snowflake error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
