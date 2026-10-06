import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

/**
 * Tests d'intégration contre un vrai PostgreSQL (embarqué, éphémère).
 * Si TEST_DATABASE_URL est défini, on l'utilise à la place (la base sera vidée entre les tests).
 * Le schéma est appliqué depuis prisma/migrations/*.sql (les mêmes fichiers que `prisma migrate deploy`).
 */
let embedded: EmbeddedPostgres | null = null;
let dir = '';

export async function setup() {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftf-pg-'));
    const port = 54000 + Math.floor(Math.random() * 1000);
    embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, createPostgresUser: process.getuid?.() === 0 });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('ftf_test');
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
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.resolve('.test-uploads'), { recursive: true, force: true });
}
