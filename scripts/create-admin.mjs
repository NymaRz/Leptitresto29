// Crée (ou met à jour) le compte administrateur du restaurant.
// Usage : npm run admin:local   ou   npm run admin:remote
// Variables possibles : ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD (sinon, saisie interactive).
// Le mot de passe n'est jamais écrit sur le disque : seul son empreinte PBKDF2 est envoyée à la base.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { webcrypto as crypto } from 'node:crypto';

const target = process.argv.includes('--remote') ? '--remote' : '--local';
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (label, envName) => process.env[envName] || (await rl.question(label)).trim();

const email = (await ask('E-mail administrateur : ', 'ADMIN_EMAIL')).toLowerCase();
const name = (await ask('Nom affiché : ', 'ADMIN_NAME')) || "Le P'tit Resto 29";
const password = await ask('Mot de passe (10 caractères minimum) : ', 'ADMIN_PASSWORD');
rl.close();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Adresse e-mail invalide.');
if (password.length < 10 || password.length > 128) throw new Error('Le mot de passe doit contenir entre 10 et 128 caractères.');

const iterations = 100000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
const passwordHash = `pbkdf2$${iterations}$${Buffer.from(salt).toString('base64')}$${Buffer.from(hash).toString('base64')}`;

const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const sql = `INSERT INTO users (id, email, name, phone, role, verified, password_hash)
VALUES (${q(crypto.randomUUID())}, ${q(email)}, ${q(name)}, '', 'admin', 1, ${q(passwordHash)})
ON CONFLICT(email) DO UPDATE SET role = 'admin', verified = 1, name = excluded.name, password_hash = excluded.password_hash;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${q(email)});`;

const dir = mkdtempSync(join(tmpdir(), 'pr29-admin-'));
try {
  const file = join(dir, 'admin.sql');
  writeFileSync(file, sql, { mode: 0o600 });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'leptitresto29', target, '--file', file], { stdio: 'inherit' });
  console.log(`Compte administrateur prêt (${target === '--remote' ? 'en ligne' : 'local'}) : ${email}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
