import { z } from 'zod';

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE','SUSPENDED','BANNED','DELETED']).optional(),
  isCreator: z.preprocess((v) => v === true || v === 'true' ? true : v === false || v === 'false' ? false : v, z.boolean().optional()),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const userStatusSchema = z.object({ status: z.enum(['ACTIVE','SUSPENDED','BANNED','DELETED']), reason: z.string().trim().max(500).optional() });
export const contentActionSchema = z.object({ status: z.enum(['PUBLISHED','HIDDEN','REMOVED']), reason: z.string().trim().max(500).optional() });
export const reportStatusSchema = z.object({ status: z.enum(['OPEN','REVIEWING','RESOLVED','DISMISSED']), reason: z.string().trim().max(500).optional() });
export const reportListQuerySchema = z.object({ status: z.enum(['OPEN','REVIEWING','RESOLVED','DISMISSED']).optional() });
export const withdrawalListQuerySchema = z.object({ status: z.enum(['PENDING','REVIEW','PROCESSING','COMPLETED','FAILED','CANCELLED']).optional() });

export const withdrawalStatusSchema = z.object({ status: z.enum(['REVIEW','PROCESSING','COMPLETED','FAILED','CANCELLED']), externalReference: z.string().trim().max(200).optional(), reason: z.string().trim().max(500).optional() });
export const transactionQuerySchema = z.object({ status: z.enum(['PENDING','PAID','FAILED','REFUNDED','REVIEW','COMPLETED','CANCELLED']).optional(), currency: z.string().regex(/^[A-Za-z]{3}$/).transform(v => v.toUpperCase()).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const refundRequestSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const fraudEventListQuerySchema = z.object({ userId: z.string().max(64).optional(), decision: z.enum(['ALLOW','REVIEW','BLOCK']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const fraudStatusSchema = z.object({ status: z.enum(['CLEAR','REVIEW','BLOCKED']), reason: z.string().trim().min(3).max(500) });
