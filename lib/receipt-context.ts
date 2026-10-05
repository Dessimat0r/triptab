import { z } from 'zod';

const id = z.string().min(1).max(100);

export const receiptAliasSchema = z.object({
  name: z.string().trim().min(1).max(60),
  itemId: id.optional(),
  memberId: id.optional(),
  scopeMemberId: id.optional(),
}).strict().superRefine((alias, context) => {
  if ((alias.itemId !== undefined) === (alias.memberId !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose exactly one item or traveller for each alias.' });
  }
});

/** References may outlive their item or traveller; callers validate new targets. */
export const receiptMemorySchema = z.object({
  notes: z.string().max(6000).default(''),
  aliases: z.array(receiptAliasSchema).max(50).default([]),
}).strict();

export type ReceiptMemory = z.infer<typeof receiptMemorySchema>;
