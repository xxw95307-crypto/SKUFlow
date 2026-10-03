import assert from 'node:assert/strict';
import test from 'node:test';
import { groupBatchFolders } from '../lib/domain/batch-folders.ts';
import { classifyBatchItem } from '../lib/server/batch-store.ts';

test('groups each product folder without splitting its spreadsheet rows', () => {
  const grouped = groupBatchFolders([
    { index: 0, name: 'spec.xlsx', relativePath: 'summer/T-SHIRT/spec.xlsx', size: 250 },
    { index: 1, name: 'front.png', relativePath: 'summer/T-SHIRT/images/front.png', size: 500 },
    { index: 2, name: 'details.csv', relativePath: 'summer/MUG/details.csv', size: 180 },
  ]);
  assert.equal(grouped.root, 'summer');
  assert.deepEqual(grouped.products.map((product) => [product.name, product.files.length]), [['T-SHIRT', 2], ['MUG', 1]]);
});

test('rejects loose files and folders without a product spreadsheet', () => {
  assert.throws(() => groupBatchFolders([
    { index: 0, name: 'a.xlsx', relativePath: 'summer/a.xlsx', size: 100 },
    { index: 1, name: 'b.xlsx', relativePath: 'summer/B/b.xlsx', size: 100 },
  ]), /商品子文件夹/);
  assert.throws(() => groupBatchFolders([
    { index: 0, name: 'a.png', relativePath: 'summer/A/a.png', size: 100 },
    { index: 1, name: 'b.xlsx', relativePath: 'summer/B/b.xlsx', size: 100 },
  ]), /缺少商品表格/);
});

test('never marks an unapproved item ready for bulk delivery', () => {
  const item = { task_status: 'FACTS_EXTRACTED', draft_count: 2, published_count: 0,
    conflict_count: 0, review_count: 1, approved_count: 1, needs_media: 0, media_plan_id: null } as const;
  assert.equal(classifyBatchItem(item as never).stage, 'NEEDS_ATTENTION');
  assert.equal(classifyBatchItem({ ...item, review_count: 0, approved_count: 2 } as never).stage, 'READY_TO_PUBLISH');
  assert.equal(classifyBatchItem({ ...item, review_count: 0, approved_count: 2, needs_media: 1 } as never).stage, 'NEEDS_ATTENTION');
});
