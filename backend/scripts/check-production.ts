/**
 * Contrôle de préparation production — AUCUNE connexion réseau, aucun secret affiché.
 *   npm run check:prod                      → lit .env.production
 *   npm run check:prod -- chemin/du/fichier → lit un autre fichier
 * Code de sortie 1 s'il reste au moins une erreur bloquante.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const file = path.resolve(process.argv[2] ?? '.env.production');
if (!fs.existsSync(file)) {
  console.error(`✖ Fichier introuvable : ${file}\n  Copiez .env.production.example en .env.production puis renseignez-le.`);
  process.exit(1);
}
dotenv.config({ path: file, override: true });
process.env.NODE_ENV = 'production';

const errors: string[] = [];
const warnings: string[] = [];
const v = (k: string) => (process.env[k] ?? '').trim();
const isLocal = (s: string) => /(^|[/@:.])(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)([:/]|$)/i.test(s);
const placeholder = (s: string) => /VOTRE-DOMAINE|UTILISATEUR|MOT_DE_PASSE|HOTE|CHANGE|REPLACE|example\.com/i.test(s);

async function main() {
  // 1. Les règles déjà codées dans src/config/env.ts (lèvent une erreur explicite)
  try {
    await import('../src/config/env');
  } catch (e) {
    errors.push(String((e as Error).message).replace(/\n/g, '\n    '));
  }

  // 2. Contrôles supplémentaires propres à la production
  const requireHttps = (k: string, scheme = 'https://') => {
    const s = v(k);
    if (!s) return;
    if (isLocal(s)) errors.push(`${k} pointe vers une machine locale`);
    else if (!s.toLowerCase().startsWith(scheme)) errors.push(`${k} doit commencer par ${scheme}`);
    if (placeholder(s)) errors.push(`${k} contient encore une valeur d'exemple`);
  };
  requireHttps('PUBLIC_BASE_URL');
  requireHttps('CDN_URL');
  requireHttps('STORAGE_ENDPOINT');
  requireHttps('LIVEKIT_URL', 'wss://');
  if (!v('CDN_URL')) warnings.push('CDN_URL vide : les lectures passeront par le stockage directement (plus lent, plus cher)');

  const db = v('DATABASE_URL');
  if (isLocal(db)) errors.push('DATABASE_URL pointe vers une base locale');
  if (placeholder(db)) errors.push('DATABASE_URL contient encore une valeur d\'exemple');
  if (db && !/sslmode=(require|verify-full|verify-ca)|ssl=true/i.test(db)) warnings.push('DATABASE_URL sans sslmode=require : vérifiez que la connexion à la base est chiffrée');

  const jwt = v('JWT_SECRET');
  if (jwt && (/^(change|secret|test|dev|password)/i.test(jwt) || new Set(jwt).size < 12)) errors.push('JWT_SECRET est trop prévisible : générez 48 octets aléatoires');

  const origins = v('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) if (!o.startsWith('https://') || isLocal(o) || o === '*' || placeholder(o)) errors.push(`CORS_ORIGINS contient une origine non sûre ou d'exemple : ${o}`);

  if (process.env.TRUST_PROXY !== 'true') warnings.push('TRUST_PROXY n\'est pas « true » : derrière un load balancer, l\'API verrait toutes les requêtes comme HTTP et les adresses IP seraient fausses (limitation de débit)');
  if (process.env.RATE_LIMIT_ENABLED === 'false') errors.push('RATE_LIMIT_ENABLED=false est interdit en production');
  if (Number(v('BCRYPT_COST') || 12) < 12) errors.push('BCRYPT_COST doit être ≥ 12 en production');

  if (v('PAYMENT_DRIVER') !== 'mypvit') warnings.push(`PAYMENT_DRIVER=${v('PAYMENT_DRIVER') || 'none'} : aucun paiement réel ne sera accepté`);
  if (v('CALL_PROVIDER') !== 'livekit') warnings.push(`CALL_PROVIDER=${v('CALL_PROVIDER') || 'none'} : les appels seront désactivés`);
  if (!v('ADMIN_USER_IDS')) warnings.push('ADMIN_USER_IDS vide : personne ne pourra utiliser l\'administration');
  if (!v('MYPVIT_URLCODE_STATUS') && v('PAYMENT_DRIVER') === 'mypvit') warnings.push('MYPVIT_URLCODE_STATUS vide : les paiements sans nouvelle iront en vérification manuelle (pas de rapprochement automatique)');

  // 3. Rapport
  console.log(`\nContrôle production — ${file}\n`);
  for (const w of warnings) console.log(`  ⚠  ${w}`);
  for (const e of errors) console.log(`  ✖  ${e}`);
  if (!errors.length && !warnings.length) console.log('  ✔  Rien à signaler');
  console.log(`\n${errors.length} erreur(s) bloquante(s), ${warnings.length} avertissement(s).`);
  process.exit(errors.length ? 1 : 0);
}
void main();
