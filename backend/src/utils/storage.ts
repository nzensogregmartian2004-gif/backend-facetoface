import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { randomToken } from './crypto';

/**
 * Abstraction de stockage des fichiers.
 * ÉTAPE 2 : pilote local (disque). À l'étape 21 il sera remplacé par un stockage objet + CDN
 * (STORAGE_* / CDN_URL) sans changer les appelants. Ne convient pas aux hébergeurs à disque éphémère.
 */
export interface FileStorage {
  saveAvatar(userId: string, data: Buffer, ext: 'jpg' | 'png' | 'webp'): Promise<string>;
  deleteByUrl(url: string): Promise<void>;
}

export const uploadRoot = path.resolve(env.UPLOAD_DIR);
const avatarDir = path.join(uploadRoot, 'avatars');
const urlPrefix = `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/uploads/avatars/`;

export const localStorage: FileStorage = {
  async saveAvatar(userId, data, ext) {
    await fs.mkdir(avatarDir, { recursive: true });
    const name = `${userId}-${randomToken(8)}.${ext}`;
    await fs.writeFile(path.join(avatarDir, name), data);
    return urlPrefix + name;
  },
  async deleteByUrl(url) {
    if (!url.startsWith(urlPrefix)) return; // URL externe : on n'y touche pas
    const name = path.basename(url.slice(urlPrefix.length));
    await fs.rm(path.join(avatarDir, name), { force: true });
  },
};

/** Détecte le vrai type d'image par signature (on ne se fie pas au type MIME déclaré). */
export function sniffImage(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}
