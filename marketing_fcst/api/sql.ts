import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

function buildJWT(account: string, username: string, privateKeyPem: string): string {
  const acc = account.toUpperCase();
  const usr = username.toUpperCase();

  const publicKey = crypto.createPublicKey(privateKeyPem);
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(pubDer).digest('base64');

  const iss = `${acc}.${usr}.${fingerprint}`;
  const sub = `${acc}.${usr}`;

  return jwt.sign({ sub }, privateKeyPem, {
    algorithm: 'RS256',
    issuer: iss,
    expiresIn: '59m',
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sql } = req.body ?? {};
  if (!sql) return res.status(400).json({ error: 'Missing sql' });

  const account       = process.env.SNOWFLAKE_ACCOUNT!;
  const username      = process.env.SNOWFLAKE_USERNAME!;
  const warehouse     = process.env.SNOWFLAKE_WAREHOUSE!;
  const database      = process.env.SNOWFLAKE_DATABASE ?? 'load';
  const role          = process.env.SNOWFLAKE_ROLE!;
  const privateKeyPem = (process.env.SNOWFLAKE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');

  let token: string;
  try {
    token = buildJWT(account, username, privateKeyPem);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: `JWT build failed: ${msg}` });
  }

  const url = `https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements?requestId=${crypto.randomUUID()}`;

  let sfRes: Response;
  try {
    sfRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      },
      body: JSON.stringify({ statement: sql, warehouse, database, role, timeout: 60 }),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(502).json({ error: `Network error: ${msg}` });
  }

  if (!sfRes.ok) {
    const errText = await sfRes.text();
    return res.status(sfRes.status).json({ error: errText.slice(0, 500) });
  }

  const body = await sfRes.json();

  const cols: string[] = (body.resultSetMetaData?.rowType ?? []).map((c: { name: string }) => c.name);
  const rows = (body.data ?? []).map((row: string[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });

  return res.json(rows);
}
