import { z } from 'zod';
export const createGroupCallSchema = z.object({ conversationId: z.string().min(1), type: z.enum(['AUDIO','VIDEO']) });
export const joinGroupCallSchema = z.object({});
