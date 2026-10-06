const { spawnSync } = require('node:child_process');

// Prisma 6 peut sélectionner le moteur JS via PRISMA_CLIENT_ENGINE_TYPE.
// Le projet utilise volontairement le moteur Rust/library et ne nécessite pas
// d'adaptateur pg. On force ce choix pendant chaque génération.
const env = { ...process.env, PRISMA_CLIENT_ENGINE_TYPE: 'library' };

let result;
const npmExecPath = process.env.npm_execpath;

if (npmExecPath) {
  // Quand le script est lancé par npm, on appelle directement le CLI npm via
  // Node au lieu de npx.cmd. Cela évite l'EINVAL de child_process sous Windows.
  result = spawnSync(process.execPath, [npmExecPath, 'exec', '--', 'prisma', 'generate'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    windowsHide: false,
  });
} else {
  // Fallback pour `node scripts/prisma-generate.cjs` lancé manuellement.
  result = spawnSync('npx', ['prisma', 'generate'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    shell: true,
    windowsHide: false,
  });
}

if (result.error) throw result.error;
if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status);
if (result.signal) process.exit(1);
