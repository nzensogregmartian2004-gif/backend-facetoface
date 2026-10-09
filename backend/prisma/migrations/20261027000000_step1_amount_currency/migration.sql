-- Étape 1 : montants multi-devises. Les colonnes `*Fcfa` deviennent `*Amount` / `price` + une colonne `currency`.
-- Les lignes existantes étaient toutes en FCFA : elles reçoivent 'XAF'. Aucune donnée n'est perdue (simples renommages).

-- Message payant
ALTER TABLE "Message" RENAME COLUMN "priceFcfa" TO "price";
ALTER TABLE "Message" ADD COLUMN "currency" VARCHAR(3);
UPDATE "Message" SET "currency" = 'XAF' WHERE "price" IS NOT NULL;

ALTER TABLE "MessagePurchase" RENAME COLUMN "grossFcfa" TO "grossAmount";
ALTER TABLE "MessagePurchase" RENAME COLUMN "commissionFcfa" TO "commissionAmount";
ALTER TABLE "MessagePurchase" RENAME COLUMN "creatorFcfa" TO "creatorAmount";
ALTER TABLE "MessagePurchase" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF';

-- Notifications
ALTER TABLE "Notification" RENAME COLUMN "amountFcfa" TO "amount";
ALTER TABLE "Notification" ADD COLUMN "currency" VARCHAR(3);
UPDATE "Notification" SET "currency" = 'XAF' WHERE "amount" IS NOT NULL;

-- Appels
ALTER TABLE "CreatorCallSettings" RENAME COLUMN "audioPriceFcfa" TO "audioPrice";
ALTER TABLE "CreatorCallSettings" RENAME COLUMN "videoPriceFcfa" TO "videoPrice";
ALTER TABLE "CreatorCallSettings" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF';

ALTER TABLE "Call" RENAME COLUMN "unitPriceFcfa" TO "unitPrice";
ALTER TABLE "Call" RENAME COLUMN "grossFcfa" TO "grossAmount";
ALTER TABLE "Call" RENAME COLUMN "consumedFcfa" TO "consumedAmount";
ALTER TABLE "Call" RENAME COLUMN "commissionFcfa" TO "commissionAmount";
ALTER TABLE "Call" RENAME COLUMN "creatorFcfa" TO "creatorAmount";
ALTER TABLE "Call" RENAME COLUMN "refundFcfa" TO "refundAmount";
ALTER TABLE "Call" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF';

-- Abonnements créateur
ALTER TABLE "CreatorSubscriptionPayment" RENAME COLUMN "grossFcfa" TO "grossAmount";
ALTER TABLE "CreatorSubscriptionPayment" RENAME COLUMN "commissionFcfa" TO "commissionAmount";
ALTER TABLE "CreatorSubscriptionPayment" RENAME COLUMN "creatorFcfa" TO "creatorAmount";
ALTER TABLE "CreatorSubscriptionPayment" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF';

-- Vidéos personnalisées (`currency` existe déjà sur la demande)
ALTER TABLE "CustomVideoRequest" RENAME COLUMN "priceFcfa" TO "price";
ALTER TABLE "CustomVideoPayment" RENAME COLUMN "grossFcfa" TO "grossAmount";
ALTER TABLE "CustomVideoPayment" RENAME COLUMN "commissionFcfa" TO "commissionAmount";
ALTER TABLE "CustomVideoPayment" RENAME COLUMN "creatorFcfa" TO "creatorAmount";
ALTER TABLE "CustomVideoPayment" ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF';
