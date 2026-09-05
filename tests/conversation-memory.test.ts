import assert from 'node:assert/strict';
import test from 'node:test';
import { schemaStatements } from '../db/schema.ts';

test('conversation memory has durable task linkage and a recency index', () => {
  const schema = schemaStatements.join('\n');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agent_conversations/);
  assert.match(schema, /task_id TEXT UNIQUE/);
  assert.match(schema, /messages_json TEXT NOT NULL/);
  assert.match(schema, /model_history_json TEXT NOT NULL/);
  assert.match(schema, /idx_agent_conversations_updated/);
});
