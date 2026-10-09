import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { randomToken } from './crypto';

/**
 * Abstraction de stockage des fichiers.
 * Pilote local (disque). À l'étape de stockage objet + CDN, il sera remplacé sans changer les appelants.
 */
type ImageExt = 'jpg' | 'png' | 'webp';

export interface FileStorage {
  saveAvatar(userId: string, data: Buffer, ext: ImageExt): Promise<string>;
  saveBanner(userId: string, data: Buffer, ext: ImageExt): Promise<string>;
  deleteByUrl(url: string): Promise<void>;
}

export const uploadRoot = path.resolve(env.UPLOAD_DIR);
const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');
const folders = {
  avatar: { dir: path.join(uploadRoot, 'avatars'), prefix: `${base}/uploads/avatars/` },
  banner: { dir: path.join(uploadRoot, 'banners'), prefix: `${base}/uploads/banners/` },
};

async function saveIn(folder: { dir: string; prefix: string }, userId: string, data: Buffer, ext: ImageExt) {
  await fs.mkdir(folder.dir, { recursive: true });
  const name = `${userId}-${randomToken(8)}.${ext}`;
  await fs.writeFile(path.join(folder.dir, name), data);
  return folder.prefix + name;
}

export const localStorage: FileStorage = {
  saveAvatar: (userId, data, ext) => saveIn(folders.avatar, userId, data, ext),
  saveBanner: (userId, data, ext) => saveIn(folders.banner, userId, data, ext),
  async deleteByUrl(url) {
    for (const folder of Object.values(folders)) {
      if (!url.startsWith(folder.prefix)) continue; // URL externe : on n'y touche pas
      const name = path.basename(url.slice(folder.prefix.length));
      await fs.rm(path.join(folder.dir, name), { force: true });
      return;
    }
  },
};

/** Détecte le vrai type d'image par signature (on ne se fie pas au type MIME déclaré). */
export function sniffImage(b: Buffer): ImageExt | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
