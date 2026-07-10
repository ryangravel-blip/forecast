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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Shared-secret gate: this endpoint runs arbitrary SQL against Snowflake using the
  // app's own service credentials, so it must not be callable by anyone who just finds
  // the URL. DASHBOARD_API_KEY is set as a Vercel env var; requests must echo it back
  // in the X-Dashboard-Key header (see execSQL() in index.html). Fails closed — if the
  // env var isn't set, every request is rejected rather than silently allowed.
  const expectedKey = process.env.DASHBOARD_API_KEY;
  const providedKey = req.headers['x-dashboard-key'];
  if (!expectedKey || providedKey !== expectedKey) {
    // TEMPORARY diagnostic (2026-07-09): reveals only whether the env var is set and
    // its length, never the actual value, to help debug a persistent "Unauthorized"
    // report without exposing the secret. Remove once resolved.
    return res.status(401).json({
      error: 'Unauthorized',
      debug: {
        envVarSet: !!expectedKey,
        envVarLength: expectedKey ? expectedKey.length : 0,
        headerReceived: !!providedKey,
        headerLength: providedKey ? String(providedKey).length : 0,
      },
    });
  }

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
  let allRows: string[][] = body.data ?? [];

  // Snowflake's SQL API v2 splits large result sets into multiple partitions.
  // The initial response only includes partition 0 — fetch the rest and
  // concatenate, or rows past the first partition silently go missing.
  const partitionCount: number = body.resultSetMetaData?.partitionInfo?.length ?? 1;
  const handle: string | undefined = body.statementHandle;
  if (partitionCount > 1 && handle) {
    for (let p = 1; p < partitionCount; p++) {
      const partUrl = `https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements/${handle}?partition=${p}`;
      const partRes = await fetch(partUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
        },
      });
      if (!partRes.ok) {
        const errText = await partRes.text();
        return res.status(partRes.status).json({ error: `Partition ${p} fetch failed: ${errText.slice(0, 500)}` });
      }
      const partBody = await partRes.json();
      allRows = allRows.concat(partBody.data ?? []);
    }
  }

  const rows = allRows.map((row: string[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });

  return res.json(rows);
}
