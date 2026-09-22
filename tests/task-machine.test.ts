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

test('routes extracted facts with gaps to human confirmation', () => {
  assert.equal(canTransition('FILES_PARSED', 'FACTS_EXTRACTED'), true);
  assert.equal(canTransition('FACTS_EXTRACTED', 'NEEDS_CONFIRMATION'), true);
});

test('exposes agent ownership and terminal state metadata', () => {
  assert.equal(TASK_STATE_METADATA.FACTS_EXTRACTED.owner, 'agent');
  assert.equal(TASK_STATE_METADATA.NEEDS_CONFIRMATION.requiresHumanAction, true);
  assert.deepEqual(getAllowedTransitions('HUMAN_APPROVED'), ['EXPORTED', 'DRAFT_CREATED', 'FACTS_EXTRACTED', 'INGESTING', 'FAILED']);
  assert.equal(isTerminalStatus('EXPORTED'), true);
  assert.equal(isTerminalStatus('FAILED'), false);
});

test('permits pre-publication backtracking to earlier pipeline steps', () => {
  assert.equal(canTransition('NEEDS_CONFIRMATION', 'INGESTING'), true);
  assert.equal(canTransition('CATEGORY_MAPPED', 'FACTS_EXTRACTED'), true);
  assert.equal(canTransition('CONTENT_GENERATED', 'INGESTING'), true);
  assert.equal(canTransition('VALIDATED', 'INGESTING'), true);
  assert.equal(canTransition('DRAFT_CREATED', 'INGESTING'), false);
  assert.equal(canTransition('EXPORTED', 'INGESTING'), false);
});
