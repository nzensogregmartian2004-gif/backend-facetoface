import { z } from 'zod';
export const disputeDecisionSchema = z.object({ type: z.enum(['CALL','CUSTOM_VIDEO']), refundAmount: z.number().int().min(0), reason: z.string().trim().min(3).max(500) });
