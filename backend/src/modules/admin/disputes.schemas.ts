import { z } from 'zod';
export const disputeDecisionSchema = z.object({ type: z.enum(['CALL','CUSTOM_VIDEO']), refundAmount: z.literal(0).default(0), reason: z.string().trim().min(3).max(500) });
