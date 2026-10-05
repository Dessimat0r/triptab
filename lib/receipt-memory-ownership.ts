import type { ReceiptMemory } from './receipt-context';

export class ReceiptMemoryOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptMemoryOwnershipError';
  }
}

function sameAlias(a: ReceiptMemory['aliases'][number], b: ReceiptMemory['aliases'][number]) {
  return a.name === b.name && a.itemId === b.itemId && a.memberId === b.memberId && a.scopeMemberId === b.scopeMemberId;
}

/** Identify a name within its speaker scope when merging trusted saved context. */
export function receiptAliasIdentity(alias: ReceiptMemory['aliases'][number]): string {
  const name = alias.name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([alias.scopeMemberId ?? null, name]);
}

/**
 * Check schema-validated memory against its trusted stored/merged baseline.
 * The actor member and active member IDs must come from server-verified trip
 * membership. Missing incoming memory removes it from a retained receipt;
 * whole-receipt deletion is a separate storage policy. No inputs are mutated.
 * Return unmatched incoming aliases for additional active-target validation.
 */
export function validateReceiptMemoryOwnership(
  previous: ReceiptMemory | undefined,
  incoming: ReceiptMemory | undefined,
  actorMemberId: string | undefined,
  activeMemberIds: ReadonlySet<string>,
): ReceiptMemory['aliases'] {
  const added = [...(incoming?.aliases ?? [])];
  for (const alias of previous?.aliases ?? []) {
    const retainedIndex = added.findIndex(candidate => sameAlias(candidate, alias));
    if (retainedIndex !== -1) added.splice(retainedIndex, 1);
    else if (alias.scopeMemberId !== undefined && activeMemberIds.has(alias.scopeMemberId) && alias.scopeMemberId !== actorMemberId) {
      throw new ReceiptMemoryOwnershipError('Keep active other travellers’ speaker-scoped aliases unchanged. Only their scoped speaker may rewrite or remove them.');
    }
  }
  for (const alias of added) {
    if (alias.scopeMemberId !== undefined && (alias.scopeMemberId !== actorMemberId || !activeMemberIds.has(alias.scopeMemberId))) {
      throw new ReceiptMemoryOwnershipError('New speaker-scoped aliases must belong to your own active traveller profile.');
    }
  }
  return added;
}
