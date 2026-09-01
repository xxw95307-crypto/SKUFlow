import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition, canTransition } from '../lib/workflow/task-machine.ts';

test('allows the Day 1 task to enter ingestion', () => {
  assert.equal(canTransition('CREATED', 'INGESTING'), true);
  assert.doesNotThrow(() => assertTransition('CREATED', 'INGESTING'));
});

test('blocks skipping human approval', () => {
  assert.equal(canTransition('VALIDATED', 'DRAFT_CREATED'), false);
  assert.throws(() => assertTransition('VALIDATED', 'DRAFT_CREATED'), /Invalid task transition/);
});

test('permits a failed ingestion to retry', () => {
  assert.equal(canTransition('FAILED', 'INGESTING'), true);
});
