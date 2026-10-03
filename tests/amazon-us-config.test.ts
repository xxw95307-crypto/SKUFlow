import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAmazonUsConnection, missingAmazonUsConnection } from '../lib/platforms/amazon-us-config.ts';

test('Amazon US connection requires all seller authorization values', () => {
  assert.deepEqual(missingAmazonUsConnection({}), [
    'AMAZON_SP_API_CLIENT_ID',
    'AMAZON_SP_API_CLIENT_SECRET',
    'AMAZON_SP_API_REFRESH_TOKEN',
    'AMAZON_SELLER_ID',
  ]);
  assert.throws(() => loadAmazonUsConnection({}), /尚未连接 Amazon 卖家/);
  const connection = loadAmazonUsConnection({
    AMAZON_SP_API_CLIENT_ID: ' client ',
    AMAZON_SP_API_CLIENT_SECRET: ' secret ',
    AMAZON_SP_API_REFRESH_TOKEN: ' refresh ',
    AMAZON_SELLER_ID: ' seller ',
  });
  assert.equal(connection.sellerId, 'seller');
  assert.equal(loadAmazonUsConnection({
    AMAZON_SP_API_CLIENT_ID: 'client', AMAZON_SP_API_CLIENT_SECRET: 'secret',
    AMAZON_SP_API_REFRESH_TOKEN: 'refresh', AMAZON_US_SELLER_ID: 'legacy-seller',
  }).sellerId, 'legacy-seller');
});
