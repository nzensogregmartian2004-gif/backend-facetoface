-- Étape 18 — Versionnage immuable des paramètres économiques et de monétisation.
-- Chaque modification reçoit une version globale et conserve ancienne valeur, nouvelle valeur,
-- administrateur, date et raison. Les revenus peuvent référencer cette version via CreatorEarning.ruleVersion.

CREATE SEQUENCE "monetization_setting_version_seq" START WITH 1 INCREMENT BY 1;

CREATE TABLE "MonetizationSettingVersion" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "settingKey" TEXT NOT NULL,
  "oldValue" JSONB,
  "newValue" JSONB NOT NULL,
  "adminId" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "configId" TEXT,
  "viewSettingId" TEXT,
  CONSTRAINT "MonetizationSettingVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MonetizationSettingVersion_version_settingKey_key"
  ON "MonetizationSettingVersion"("version", "settingKey");
CREATE INDEX "MonetizationSettingVersion_settingKey_changedAt_idx"
  ON "MonetizationSettingVersion"("settingKey", "changedAt");
CREATE INDEX "MonetizationSettingVersion_adminId_changedAt_idx"
  ON "MonetizationSettingVersion"("adminId", "changedAt");
CREATE INDEX "MonetizationSettingVersion_version_changedAt_idx"
  ON "MonetizationSettingVersion"("version", "changedAt");

ALTER TABLE "MonetizationSettingVersion"
  ADD CONSTRAINT "MonetizationSettingVersion_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonetizationSettingVersion"
  ADD CONSTRAINT "MonetizationSettingVersion_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "AppConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MonetizationSettingVersion"
  ADD CONSTRAINT "MonetizationSettingVersion_viewSettingId_fkey"
  FOREIGN KEY ("viewSettingId") REFERENCES "ViewMonetizationSetting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Migration des paramètres historiques vers le centre AppConfig avant création de la version initiale.
INSERT INTO "AppConfig" ("id", "key", "value", "type", "enabled", "description", "defaultValue", "category")
SELECT
  'cfg_' || md5(v.id || ':step18'),
  m."configKey",
  CASE WHEN m."configKey" IN ('MONETIZATION.REQUIRE_VERIFIED_ACCOUNT','MONETIZATION.REQUIRE_NO_ACTIVE_SANCTION','MONETIZATION.REQUIRE_ORIGINAL_CONTENT','MONETIZATION.EXCLUDE_ARTIFICIAL_VIEWS','MONETIZATION.EXCLUDE_REMOVED_CONTENT','MONETIZATION.EXCLUDE_PRIVATE_CONTENT')
       THEN to_jsonb(v.value > 0)
       ELSE to_jsonb(CASE WHEN m."configKey" = 'CREATOR_POOL.CREATOR_PERCENT' THEN v.value / 100.0 ELSE v.value END) END,
  m."type"::"AppConfigType", true, m.description,
  CASE WHEN m."configKey" IN ('MONETIZATION.REQUIRE_VERIFIED_ACCOUNT','MONETIZATION.REQUIRE_NO_ACTIVE_SANCTION','MONETIZATION.REQUIRE_ORIGINAL_CONTENT','MONETIZATION.EXCLUDE_ARTIFICIAL_VIEWS','MONETIZATION.EXCLUDE_REMOVED_CONTENT','MONETIZATION.EXCLUDE_PRIVATE_CONTENT')
       THEN to_jsonb(v.value > 0)
       ELSE to_jsonb(CASE WHEN m."configKey" = 'CREATOR_POOL.CREATOR_PERCENT' THEN v.value / 100.0 ELSE v.value END) END,
  m.category::"AppConfigCategory"
FROM "ViewMonetizationSetting" v
JOIN (VALUES
  ('CREATOR_POOL_SHARE_BPS','CREATOR_POOL.CREATOR_PERCENT','DECIMAL','CREATOR_POOL','Part des revenus publicitaires affectée au Creator Pool.'),
  ('MIN_SUBSCRIBERS','MONETIZATION.MIN_SUBSCRIBERS','INTEGER','MONETIZATION','Nombre minimum d’abonnés pour la monétisation.'),
  ('MIN_WATCH_TIME_SECONDS','MONETIZATION.MIN_WATCH_TIME_SECONDS','INTEGER','MONETIZATION','Temps de visionnage minimum des vidéos longues.'),
  ('WATCH_TIME_PERIOD_DAYS','MONETIZATION.WATCH_PERIOD_DAYS','INTEGER','MONETIZATION','Période de calcul des heures de visionnage.'),
  ('MIN_SHORT_VIEWS','MONETIZATION.MIN_SHORT_VIEWS','INTEGER','MONETIZATION','Vues Shorts minimum.'),
  ('SHORTS_PERIOD_DAYS','SHORTS.VIEWS_PERIOD_DAYS','INTEGER','SHORTS','Période de calcul des vues Shorts.'),
  ('MIN_PUBLICATIONS','MONETIZATION.MIN_PUBLICATIONS','INTEGER','MONETIZATION','Nombre minimum de publications.'),
  ('PUBLICATIONS_PERIOD_DAYS','MONETIZATION.PUBLICATIONS_PERIOD_DAYS','INTEGER','MONETIZATION','Période de calcul des publications.'),
  ('REQUIRE_VERIFIED_ACCOUNT','MONETIZATION.REQUIRE_VERIFIED_ACCOUNT','BOOLEAN','MONETIZATION','Exige un compte vérifié.'),
  ('REQUIRE_NO_ACTIVE_SANCTION','MONETIZATION.REQUIRE_NO_ACTIVE_SANCTION','BOOLEAN','MONETIZATION','Exige l’absence de sanction active.'),
  ('REQUIRE_ORIGINAL_CONTENT','MONETIZATION.REQUIRE_ORIGINAL_CONTENT','BOOLEAN','MONETIZATION','Exige du contenu original.'),
  ('EXCLUDE_ARTIFICIAL_VIEWS','MONETIZATION.EXCLUDE_ARTIFICIAL_VIEWS','BOOLEAN','MONETIZATION','Exclut les vues artificielles.'),
  ('EXCLUDE_REMOVED_CONTENT','MONETIZATION.EXCLUDE_REMOVED_CONTENT','BOOLEAN','MONETIZATION','Exclut le contenu supprimé.'),
  ('EXCLUDE_PRIVATE_CONTENT','MONETIZATION.EXCLUDE_PRIVATE_CONTENT','BOOLEAN','MONETIZATION','Exclut le contenu privé.'),
  ('MIN_PAYOUT_AGE','MONETIZATION.MIN_PAYMENT_AGE','INTEGER','MONETIZATION','Âge minimum pour recevoir des paiements.'),
  ('REQUIRE_MANUAL_VALIDATION','MONETIZATION.REQUIRE_MANUAL_VALIDATION','BOOLEAN','MONETIZATION','Exige une validation manuelle.'),
  ('VIDEO_MIN_DURATION_SECONDS','VIDEOS.MIN_DURATION_SECONDS','INTEGER','VIDEOS','Durée minimale des vidéos longues.'),
  ('VIDEO_MIN_WATCHED_SECONDS','VIDEOS.MIN_WATCHED_SECONDS','INTEGER','VIDEOS','Durée minimale regardée pour une vue qualifiée vidéo.'),
  ('VIDEO_MIN_WATCH_PERCENT_BPS','VIDEOS.MIN_WATCH_PERCENT_BPS','INTEGER','VIDEOS','Pourcentage minimal regardé pour une vue qualifiée vidéo.'),
  ('SHORT_MIN_DURATION_SECONDS','SHORTS.MIN_DURATION_SECONDS','INTEGER','SHORTS','Durée minimale des Shorts.'),
  ('SHORT_MIN_WATCHED_SECONDS','SHORTS.MIN_WATCHED_SECONDS','INTEGER','SHORTS','Durée minimale regardée pour une vue qualifiée Short.'),
  ('SHORT_MIN_WATCH_PERCENT_BPS','SHORTS.MIN_WATCH_PERCENT_BPS','INTEGER','SHORTS','Pourcentage minimal regardé pour une vue qualifiée Short.'),
  ('LIVE_MIN_DURATION_SECONDS','LIVES.MIN_DURATION_SECONDS','INTEGER','LIVES','Durée minimale d’un Live éligible, en secondes.'),
  ('LIVE_MIN_VIEWERS','LIVES.MIN_VIEWERS','INTEGER','LIVES','Nombre minimum de spectateurs.'),
  ('LIVE_MIN_UNIQUE_VIEWERS','LIVES.MIN_UNIQUE_VIEWERS','INTEGER','LIVES','Nombre minimum de spectateurs uniques.'),
  ('LIVE_MIN_WATCH_TIME_SECONDS','LIVES.MIN_WATCH_TIME_SECONDS','INTEGER','LIVES','Temps de visionnage minimum d’un Live.'),
  ('LIVE_MIN_ENGAGEMENT_BPS','LIVES.MIN_ENGAGEMENT_BPS','INTEGER','LIVES','Engagement minimum d’un Live, en points de base.')
) AS m("legacyKey","configKey","type","category",description) ON m."legacyKey" = v.key
ON CONFLICT ("key") DO NOTHING;

-- Les paramètres historiques de l'ancien module de monétisation des vues sont désormais versionnables
-- dans le même journal. Leur valeur courante reste conservée pour compatibilité.
INSERT INTO "MonetizationSettingVersion"
  ("id", "version", "settingKey", "oldValue", "newValue", "adminId", "changedAt", "reason", "viewSettingId")
SELECT
  'msetv_' || md5(v.id),
  1,
  v.key,
  NULL,
  to_jsonb(v.value),
  NULL,
  COALESCE(v."createdAt", CURRENT_TIMESTAMP),
  'INITIAL_CONFIGURATION',
  v.id
FROM "ViewMonetizationSetting" v
WHERE NOT EXISTS (
  SELECT 1 FROM "MonetizationSettingVersion" h WHERE h."settingKey" = v.key
);

SELECT setval(
  'monetization_setting_version_seq',
  GREATEST(1, COALESCE((SELECT MAX("version") FROM "MonetizationSettingVersion"), 1)),
  EXISTS (SELECT 1 FROM "MonetizationSettingVersion")
);

ALTER TABLE "AdvertisingRevenue" ADD COLUMN IF NOT EXISTS "ruleVersion" TEXT;
ALTER TABLE "CreatorPool" ADD COLUMN IF NOT EXISTS "ruleVersion" TEXT;
