const snowflake = require('snowflake-sdk');
const crypto    = require('crypto');

snowflake.configure({ logLevel: 'WARN' });

let _conn = null;

function getPrivateKeyPem(raw) {
  // Normalize escaped newlines (Vercel stores multiline env vars this way)
  const pem = raw.replace(/\\n/g, '\n').trim();

  if (!pem.startsWith('-----BEGIN')) {
    throw new Error('SNOWFLAKE_PRIVATE_KEY does not look like a PEM — check the env var value');
  }

  const passphrase = process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE || undefined;

  // Import the key (handles PKCS#1 or PKCS#8, encrypted or not)
  let keyObj;
  try {
    keyObj = crypto.createPrivateKey({ key: pem, ...(passphrase ? { passphrase } : {}) });
  } catch (e) {
    throw new Error('Failed to parse private key: ' + e.message);
  }

  // Snowflake SDK JWT auth requires unencrypted PKCS#8 PEM
  return keyObj.export({ type: 'pkcs8', format: 'pem' });
}

function connect() {
  if (_conn) return Promise.resolve(_conn);

  const rawKey = process.env.SNOWFLAKE_PRIVATE_KEY || '';
  if (!rawKey) throw new Error('SNOWFLAKE_PRIVATE_KEY env var is not set');

  const privateKey = getPrivateKeyPem(rawKey);

  const conn = snowflake.createConnection({
    account:       process.env.SNOWFLAKE_ACCOUNT,
    username:      process.env.SNOWFLAKE_USERNAME,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey,
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

  const first = sql.trim().toUpperCase();
  if (!first.startsWith('SELECT') && !first.startsWith('WITH')) {
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
