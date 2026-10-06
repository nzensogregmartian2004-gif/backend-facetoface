import { z } from 'zod';
import { env } from '../config/env';
import { ageOn } from './dates';

const RESERVED = new Set(['admin', 'administrator', 'support', 'help', 'aide', 'facetoface', 'face_to_face', 'moderator', 'moderation', 'staff', 'system', 'root', 'api', 'null', 'undefined', 'me', 'official', 'suggestions', 'search']);

export const emailSchema = z.string().trim().toLowerCase().email('Adresse e-mail invalide').max(254);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{3,20}$/, '3 à 20 caractères : lettres, chiffres, _ ou .')
  .refine((v) => !v.startsWith('.') && !v.endsWith('.') && !v.includes('..'), 'Le point ne peut pas être au début, à la fin ou doublé')
  .refine((v) => !RESERVED.has(v) && !v.startsWith('deleted_'), 'Cet identifiant est réservé');

export const passwordSchema = z
  .string()
  .min(8, 'Au moins 8 caractères')
  .max(72, '72 caractères maximum')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Doit contenir au moins une lettre et un chiffre');

export const displayNameSchema = z.string().trim().min(2, 'Au moins 2 caractères').max(50, '50 caractères maximum');

export const birthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu : AAAA-MM-JJ')
  .refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Date invalide')
  .refine((v) => new Date(`${v}T00:00:00Z`) <= new Date(), 'La date ne peut pas être dans le futur')
  .refine((v) => ageOn(new Date(`${v}T00:00:00Z`)) <= 120, 'Date invalide')
  .refine((v) => ageOn(new Date(`${v}T00:00:00Z`)) >= env.MIN_REGISTRATION_AGE, `Vous devez avoir au moins ${env.MIN_REGISTRATION_AGE} ans`);

export const countrySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Code pays ISO à 2 lettres (ex. GA)');

export const linksSchema = z
  .array(z.string().trim().url('Lien invalide').max(200).refine((u) => /^https?:\/\//i.test(u), 'Lien http(s) uniquement'))
  .max(5, '5 liens maximum');

export const codeSchema = z.string().trim().regex(/^\d{6}$/, 'Code à 6 chiffres');
