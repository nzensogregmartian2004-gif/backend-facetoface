-- Étape 9 : notification d'invitation co-host. Valeur présente dans schema.prisma, absente des migrations.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LIVE_COHOST_INVITE';
