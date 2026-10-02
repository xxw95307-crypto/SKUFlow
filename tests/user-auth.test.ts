import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, normalizePhone, secureEqual, verifyPassword } from '../lib/server/account-auth.ts';
import { checkPnvsCode, sendPnvsCode, signAliyunRequest } from '../lib/server/aliyun-pnvs.ts';

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

const pnvsBindings = {
  ALIYUN_PNVS_ACCESS_KEY_ID: 'test-id',
  ALIYUN_PNVS_ACCESS_KEY_SECRET: 'test-secret',
  ALIYUN_PNVS_SIGN_NAME: 'system-sign',
  ALIYUN_PNVS_TEMPLATE_CODE: '100001',
} as Parameters<typeof sendPnvsCode>[0];

test('PNVS sends a provider-generated code without exposing its value', async () => {
  const requests: URL[] = [];
  await sendPnvsCode(pnvsBindings, '13800138000', (async (url) => {
    requests.push(new URL(String(url)));
    return Response.json({ Code: 'OK', Success: true, Model: { BizId: 'example' } });
  }) as typeof fetch);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].hostname, 'dypnsapi.aliyuncs.com');
  assert.equal(requests[0].searchParams.get('PhoneNumber'), '13800138000');
  assert.equal(requests[0].searchParams.get('ReturnVerifyCode'), 'false');
  assert.deepEqual(JSON.parse(requests[0].searchParams.get('TemplateParam')!), { code: '##code##', min: '5' });
  assert.equal(requests[0].searchParams.get('CodeLength'), '6');
});

test('PNVS login requires Model.VerifyResult PASS, not merely an OK request', async () => {
  const response = (verifyResult: string) => (async () => Response.json({ Code: 'OK', Success: true, Model: { VerifyResult: verifyResult } })) as typeof fetch;
  assert.equal(await checkPnvsCode(pnvsBindings, '13800138000', '123456', response('UNKNOWN')), false);
  assert.equal(await checkPnvsCode(pnvsBindings, '13800138000', '123456', response('PASS')), true);
});
