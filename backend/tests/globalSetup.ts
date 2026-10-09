import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import net from 'node:net';
import pg from 'pg';

/**
 * Tests d'intégration contre un vrai PostgreSQL (embarqué, éphémère).
 * Si TEST_DATABASE_URL est défini, on l'utilise à la place (la base sera vidée entre les tests).
 * Le schéma est appliqué depuis prisma/migrations/*.sql (les mêmes fichiers que `prisma migrate deploy`).
 *
 * Encodage : la base de test est créée explicitement en UTF8. Sans cela, sous Windows, le cluster
 * prend la page de code locale (WIN1252) et les emojis des cadeaux ne peuvent pas être insérés.
 */
/**
 * Port libre fourni par le système. Un port tiré au hasard peut tomber dans une plage réservée par Windows
 * (Hyper-V, WSL, Docker) : PostgreSQL ne peut alors pas s'y lier (« Permission denied »).
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('port introuvable'))));
    });
  });
}

let embedded: EmbeddedPostgres | null = null;
let dir = '';

export async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftf-pg-'));
    const port = await freePort();
    embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, createPostgresUser: process.getuid?.() === 0 });
    await embedded.initialise();
    await embedded.start();
    const admin = new pg.Client({ connectionString: `postgresql://postgres:postgres@localhost:${port}/postgres` });
    await admin.connect();
    await admin.query(`CREATE DATABASE "ftf_test" WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    await admin.end();
    url = `postgresql://postgres:postgres@localhost:${port}/ftf_test`;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const root = path.resolve('prisma/migrations');
  for (const d of fs.readdirSync(root).sort()) {
    const f = path.join(root, d, 'migration.sql');
    if (fs.existsSync(f)) await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  process.env.DATABASE_URL = url;
  (globalThis as { __ftfUrl?: string }).__ftfUrl = url;
}

export async function teardown() {
  if (embedded) await embedded.stop();
  // Windows : le moteur libère ses fichiers avec un léger retard ; on réessaie plutôt que de faire échouer la suite.
  const rm = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* résidu temporaire sans conséquence */ } };
  if (dir) rm(dir);
  rm(path.resolve('.test-uploads'));
}
