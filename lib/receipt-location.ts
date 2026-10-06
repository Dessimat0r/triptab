import { z } from 'zod';

export const receiptLocationSchema = z.object({
  label: z.string().trim().min(1).max(300),
  source: z.enum(['user', 'receipt', 'chat']).default('user'),
}).strict();
// A device position is a hint, not proof of where an earlier purchase occurred.
export const receiptLocationHintSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().min(0).max(10000000),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReceiptLocation = z.infer<typeof receiptLocationSchema>;
export type ReceiptLocationHint = z.infer<typeof receiptLocationHintSchema>;
