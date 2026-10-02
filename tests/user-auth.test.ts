import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, normalizePhone, secureEqual, verifyPassword } from '../lib/server/account-auth.ts';
import { signAliyunRequest } from '../lib/server/aliyun-sms.ts';

test('passwords use a salted slow hash and reject wrong credentials', async () => {
  const first = await hashPassword('a-secure-password');
  const second = await hashPassword('a-secure-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a-secure-password', first), true);
  assert.equal(await verifyPassword('a-wrong-password', first), false);
  assert.equal(await verifyPassword('a-secure-password', null), false);
});

test('phone and constant-time code comparison reject malformed values', () => {
  assert.equal(normalizePhone('+8613800138000'), '13800138000');
  assert.equal(normalizePhone('13800138000'), '13800138000');
  assert.equal(normalizePhone('1380013800'), null);
  assert.equal(secureEqual('123456', '123457'), false);
});

test('Alibaba Cloud V3 signature matches the published reference vector', async () => {
  const signed = await signAliyunRequest('YourAccessKeyId', 'YourAccessKeySecret', 'POST', {
    ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd', RegionId: 'cn-shanghai',
  }, {
    host: 'ecs.cn-shanghai.aliyuncs.com',
    'x-acs-action': 'RunInstances',
    'x-acs-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-acs-date': '2023-10-26T10:22:32Z',
    'x-acs-signature-nonce': '3156853299f313e23d1673dc12e1703d',
    'x-acs-version': '2014-05-26',
  });
  assert.match(signed.authorization, /Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0$/);
});
