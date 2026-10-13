import { z } from 'zod';


export const createConversationSchema = z.object({
    body: z.object({
        title: z.string().max(200).optional(),
        documentId: z.cuid().optional(),
    }),
});

export const sendMessageSchema = z.object({
    params: z.object({
        id: z.cuid('Invalid conversation ID'),
    }),
    body: z.object({
        content: z.string()
        .min(1, 'Message cannot be empty')
        .max(10000, 'Message too long'),
        documentId: z.cuid().optional(),
    }),
});

export const conversationParamsSchema = z.object({
    params: z.object({
        id: z.cuid('Invalid conversation ID'),
    }),
});
