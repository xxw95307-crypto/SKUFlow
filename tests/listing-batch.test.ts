import test from 'node:test';
import assert from 'node:assert/strict';
import { selectListingDraftBatch } from '../lib/agents/listing-batch.ts';

test('multi-market Listing generation processes only unfinished drafts in bounded batches', () => {
  const drafts = [
    { id: 'ca', status: 'VALIDATED', payload: { fields: { title: '已完成' } } },
    { id: 'us', status: 'PLANNED', payload: {} },
    { id: 'jp', status: 'PLANNED', payload: {} },
    { id: 'gb', status: 'PLANNED', payload: {} },
    { id: 'approved', status: 'APPROVED', payload: { fields: {} } },
  ];
  assert.deepEqual(selectListingDraftBatch(drafts).map((draft) => draft.id), ['us']);
  assert.deepEqual(selectListingDraftBatch(drafts, ['ca', 'approved', 'gb']).map((draft) => draft.id), ['ca']);
});
