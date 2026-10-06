CREATE TYPE "FinancialTransactionType" AS ENUM ('PAYMENT','REFUND','WITHDRAWAL','ADJUSTMENT');
CREATE TYPE "FinancialTransactionStatus" AS ENUM ('PENDING','PAID','FAILED','REFUNDED','REVIEW','COMPLETED','CANCELLED');
CREATE TYPE "FinancialPaymentMethod" AS ENUM ('MOBILE_MONEY','CARD','BANK_TRANSFER','WALLET','OTHER');
CREATE TYPE "WalletLedgerType" AS ENUM ('EARNING','WITHDRAWAL_HOLD','WITHDRAWAL_COMPLETED','WITHDRAWAL_RELEASED','REFUND','ADJUSTMENT');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING','REVIEW','PROCESSING','COMPLETED','FAILED','CANCELLED');
CREATE TYPE "WithdrawalMethod" AS ENUM ('MOBILE_MONEY','BANK_TRANSFER','OTHER');

CREATE TABLE "Wallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "availableAmount" INTEGER NOT NULL DEFAULT 0,
  "pendingAmount" INTEGER NOT NULL DEFAULT 0,
  "withdrawnAmount" INTEGER NOT NULL DEFAULT 0,
  "blockedAmount" INTEGER NOT NULL DEFAULT 0,
  "refundedAmount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Wallet_userId_currency_key" ON "Wallet"("userId","currency");
CREATE INDEX "Wallet_userId_updatedAt_idx" ON "Wallet"("userId","updatedAt");
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WalletLedgerEntry" (
  "id" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "WalletLedgerType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "sourceType" TEXT,
  "sourceId" TEXT,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalletLedgerEntry_sourceType_sourceId_type_key" ON "WalletLedgerEntry"("sourceType","sourceId","type");
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId","createdAt");
CREATE INDEX "WalletLedgerEntry_userId_currency_createdAt_idx" ON "WalletLedgerEntry"("userId","currency","createdAt");
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FinancialTransaction" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "type" "FinancialTransactionType" NOT NULL,
  "status" "FinancialTransactionStatus" NOT NULL DEFAULT 'PENDING',
  "userId" TEXT NOT NULL,
  "creatorId" TEXT,
  "grossAmount" INTEGER NOT NULL,
  "platformFeeAmount" INTEGER NOT NULL DEFAULT 0,
  "creatorAmount" INTEGER NOT NULL DEFAULT 0,
  "refundedAmount" INTEGER NOT NULL DEFAULT 0,
  "currency" VARCHAR(3) NOT NULL,
  "method" "FinancialPaymentMethod" NOT NULL,
  "externalReference" TEXT,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "refundStatus" TEXT,
  "failureReason" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "refundedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancialTransaction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinancialTransaction_reference_key" ON "FinancialTransaction"("reference");
CREATE UNIQUE INDEX "FinancialTransaction_sourceType_sourceId_key" ON "FinancialTransaction"("sourceType","sourceId");
CREATE INDEX "FinancialTransaction_userId_createdAt_idx" ON "FinancialTransaction"("userId","createdAt");
CREATE INDEX "FinancialTransaction_creatorId_createdAt_idx" ON "FinancialTransaction"("creatorId","createdAt");
CREATE INDEX "FinancialTransaction_status_createdAt_idx" ON "FinancialTransaction"("status","createdAt");
CREATE INDEX "FinancialTransaction_currency_createdAt_idx" ON "FinancialTransaction"("currency","createdAt");
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Withdrawal" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "amount" INTEGER NOT NULL,
  "fee" INTEGER NOT NULL DEFAULT 0,
  "netAmount" INTEGER NOT NULL,
  "method" "WithdrawalMethod" NOT NULL,
  "destinationHint" TEXT NOT NULL,
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "externalReference" TEXT,
  "failureReason" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Withdrawal_externalReference_key" ON "Withdrawal"("externalReference");
CREATE INDEX "Withdrawal_userId_currency_status_requestedAt_idx" ON "Withdrawal"("userId","currency","status","requestedAt");
CREATE INDEX "Withdrawal_status_requestedAt_idx" ON "Withdrawal"("status","requestedAt");
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
