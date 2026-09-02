import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTransition, canTransition, getAllowedTransitions, isTerminalStatus, TASK_STATE_METADATA } from '../lib/workflow/task-machine.ts';

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

test('requires unified parsing before fact extraction', () => {
  assert.equal(canTransition('INGESTING', 'FACTS_EXTRACTED'), false);
  assert.equal(canTransition('INGESTING', 'FILES_PARSED'), true);
  assert.equal(canTransition('FILES_PARSED', 'FACTS_EXTRACTED'), true);
});

test('exposes agent ownership and terminal state metadata', () => {
  assert.equal(TASK_STATE_METADATA.FACTS_EXTRACTED.owner, 'agent');
  assert.equal(TASK_STATE_METADATA.NEEDS_CONFIRMATION.requiresHumanAction, true);
  assert.deepEqual(getAllowedTransitions('HUMAN_APPROVED'), ['EXPORTED', 'DRAFT_CREATED', 'FAILED']);
  assert.equal(isTerminalStatus('EXPORTED'), true);
  assert.equal(isTerminalStatus('FAILED'), false);
});
