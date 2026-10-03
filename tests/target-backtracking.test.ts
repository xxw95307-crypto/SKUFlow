import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenTargetSelection } from '../lib/agents/commerce-orchestrator.ts';

test('a request to redo platform and market selection opens the picker before the agent chooses a stage tool', () => {
  assert.equal(shouldOpenTargetSelection('我想重新进行平台站点的选择', 'task_1', 0), true);
  assert.equal(shouldOpenTargetSelection('之前的站点选错了，想换一下', 'task_1', 0), true);
  assert.equal(shouldOpenTargetSelection('我想重新生成一张图片', 'task_1', 0), false);
  assert.equal(shouldOpenTargetSelection('我想重新进行平台站点的选择', null, 0), false);
  assert.equal(shouldOpenTargetSelection('我想重新进行平台站点的选择', 'task_1', 1), false);
});
