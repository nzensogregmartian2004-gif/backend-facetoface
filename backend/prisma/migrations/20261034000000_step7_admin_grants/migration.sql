-- Étape 7 (révision) : permissions individuelles, statut du compte admin, journal enrichi.
-- Les anciens modérateurs deviennent administrateurs avec les permissions du modèle « Modérateur ».
-- Ces attributions sont posées par le compte lui-même : aucune autre autorité n'existait avant cette migration.

CREATE TABLE "AdminPermissionGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "grantedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminPermissionGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminPermissionGrant_userId_permission_key" ON "AdminPermissionGrant"("userId", "permission");
CREATE INDEX "AdminPermissionGrant_grantedById_idx" ON "AdminPermissionGrant"("grantedById");
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminPermissionGrant" ADD CONSTRAINT "AdminPermissionGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "AdminPermissionGrant" ("id", "userId", "permission", "grantedById")
SELECT md5(random()::text || clock_timestamp()::text || u."id" || p.perm), u."id", p.perm, u."id"
FROM "User" u
CROSS JOIN (VALUES
  ('users.view'), ('moderation.reports.view'), ('moderation.content.moderate'), ('moderation.lives.view'), ('creators.view')
) AS p(perm)
WHERE u."adminRole"::text = 'MODERATOR';

CREATE TYPE "AdminRole_new" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');
ALTER TABLE "User" ALTER COLUMN "adminRole" TYPE "AdminRole_new" USING (
  CASE WHEN "adminRole"::text = 'MODERATOR' THEN 'ADMIN' ELSE "adminRole"::text END
)::"AdminRole_new";
DROP TYPE "AdminRole";
ALTER TYPE "AdminRole_new" RENAME TO "AdminRole";

CREATE TYPE "AdminAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
ALTER TABLE "User" ADD COLUMN "adminStatus" "AdminAccountStatus",
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
UPDATE "User" SET "adminStatus" = 'ACTIVE' WHERE "adminRole" IS NOT NULL AND "adminRole" <> 'USER';

CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'REFUSED', 'ERROR');
ALTER TABLE "AdminAuditLog" ADD COLUMN "module" TEXT,
  ADD COLUMN "result" "AuditResult" NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN "oldValue" JSONB,
  ADD COLUMN "newValue" JSONB;
CREATE INDEX "AdminAuditLog_module_createdAt_idx" ON "AdminAuditLog"("module", "createdAt");
CREATE INDEX "AdminAuditLog_result_createdAt_idx" ON "AdminAuditLog"("result", "createdAt");

-- Comptes administrateur sans date de naissance (contrainte relâchée ; aucune donnée modifiée).
ALTER TABLE "User" ALTER COLUMN "birthDate" DROP NOT NULL;
