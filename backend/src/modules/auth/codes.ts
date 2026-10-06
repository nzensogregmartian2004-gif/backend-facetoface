import type { CodePurpose, User } from '@prisma/client';
import { prisma } from '../../config/db';
import { env } from '../../config/env';
import { hmac, randomCode, safeEqual } from '../../utils/crypto';
import { badRequest } from '../../utils/errors';
import { mailer } from '../../utils/mailer';

const hashCode = (userId: string, purpose: CodePurpose, code: string) => hmac(`${userId}:${purpose}:${code}`);

/** Crée un code à usage unique (les précédents du même type sont invalidés) et l'envoie par e-mail. */
export async function issueCode(user: User, purpose: CodePurpose) {
  const code = randomCode();
  await prisma.$transaction([
    prisma.oneTimeCode.updateMany({ where: { userId: user.id, purpose, consumedAt: null }, data: { consumedAt: new Date() } }),
    prisma.oneTimeCode.create({
      data: { userId: user.id, purpose, codeHash: hashCode(user.id, purpose, code), expiresAt: new Date(Date.now() + env.CODE_TTL_MINUTES * 60_000) },
    }),
  ]);
  const verification = purpose === 'EMAIL_VERIFICATION';
  try {
    await mailer.send({
      to: user.email,
      subject: verification ? 'Face to Face — votre code de vérification' : 'Face to Face — réinitialisation du mot de passe',
      text:
        `Bonjour ${user.displayName},\n\n` +
        (verification ? 'Voici votre code pour vérifier votre adresse e-mail' : 'Voici votre code pour réinitialiser votre mot de passe') +
        ` : ${code}\n\nIl est valable ${env.CODE_TTL_MINUTES} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    });
  } catch (e) {
    console.error('[mail] envoi impossible', e);
  }
}

/** Vérifie un code ; le consomme en cas de succès. Échoue de façon uniforme (CODE_INVALID). */
export async function consumeCode(userId: string, purpose: CodePurpose, code: string) {
  const invalid = () => badRequest('CODE_INVALID', 'Code invalide ou expiré');
  const row = await prisma.oneTimeCode.findFirst({
    where: { userId, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || row.attempts >= env.CODE_MAX_ATTEMPTS) throw invalid();
  if (!safeEqual(row.codeHash, hashCode(userId, purpose, code))) {
    const attempts = row.attempts + 1;
    await prisma.oneTimeCode.update({ where: { id: row.id }, data: { attempts, ...(attempts >= env.CODE_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) } });
    throw invalid();
  }
  // Consommation atomique : un code ne peut servir qu'une fois même en cas de requêtes simultanées.
  const done = await prisma.oneTimeCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (done.count !== 1) throw invalid();
}
