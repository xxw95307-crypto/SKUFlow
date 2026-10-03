export const LISTING_BATCH_SIZE = 1;

interface DraftForBatch {
  id: string;
  status: string;
  payload: Record<string, unknown>;
}

export function selectListingDraftBatch<T extends DraftForBatch>(drafts: readonly T[], requestedIds?: readonly string[]): T[] {
  const requested = requestedIds ? new Set(requestedIds) : null;
  return drafts.filter((draft) => {
    if (draft.status === 'APPROVED' || draft.status === 'DRAFT_CREATED') return false;
    return requested ? requested.has(draft.id) : draft.status === 'PLANNED' || Object.keys(draft.payload).length === 0;
  }).slice(0, LISTING_BATCH_SIZE);
}
