import type { AppBindings } from '@/db/client';

const encoder = new TextEncoder();
const host = 'dypnsapi.aliyuncs.com';
const algorithm = 'ACS3-HMAC-SHA256';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export async function signAliyunRequest(accessKeyId: string, accessKeySecret: string, method: string, query: Record<string, string>, headers: Record<string, string>): Promise<{ url: string; authorization: string }> {
  const canonicalQuery = Object.entries(query).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const sortedHeaders = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonicalHeaders = sortedHeaders.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = sortedHeaders.map(([key]) => key).join(';');
  const payloadHash = await sha256('');
  const canonicalRequest = [method, '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = `${algorithm}\n${await sha256(canonicalRequest)}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(accessKeySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign))));
  return {
    url: `https://${headers.host}/?${canonicalQuery}`,
    authorization: `${algorithm} Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

export function pnvsConfigured(bindings: AppBindings): boolean {
  return Boolean(bindings.ALIYUN_PNVS_ACCESS_KEY_ID?.trim() && bindings.ALIYUN_PNVS_ACCESS_KEY_SECRET?.trim()
    && bindings.ALIYUN_PNVS_SIGN_NAME?.trim() && bindings.ALIYUN_PNVS_TEMPLATE_CODE?.trim());
}

type PnvsResult = { Code?: string; Success?: boolean; Model?: { VerifyResult?: string } };

async function requestPnvs(bindings: AppBindings, action: 'SendSmsVerifyCode' | 'CheckSmsVerifyCode', query: Record<string, string>, fetchImpl: typeof fetch): Promise<PnvsResult> {
  if (!pnvsConfigured(bindings)) throw new Error('短信认证服务尚未配置');
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-content-sha256': await sha256(''),
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': crypto.randomUUID(),
    'x-acs-version': '2017-05-25',
  };
  const signed = await signAliyunRequest(bindings.ALIYUN_PNVS_ACCESS_KEY_ID!.trim(), bindings.ALIYUN_PNVS_ACCESS_KEY_SECRET!.trim(), 'POST', query, headers);
  const response = await fetchImpl(signed.url, {
    method: 'POST',
    headers: { ...headers, authorization: signed.authorization, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({})) as PnvsResult;
  if (!response.ok || result.Code !== 'OK' || result.Success !== true) throw new Error('短信认证服务请求失败');
  return result;
}

export async function sendPnvsCode(bindings: AppBindings, phone: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await requestPnvs(bindings, 'SendSmsVerifyCode', {
    PhoneNumber: phone,
    SignName: bindings.ALIYUN_PNVS_SIGN_NAME!.trim(),
    TemplateCode: bindings.ALIYUN_PNVS_TEMPLATE_CODE!.trim(),
    TemplateParam: JSON.stringify({ code: '##code##', min: '5' }),
    CodeLength: '6',
    CodeType: '1',
    ValidTime: '300',
    Interval: '60',
    DuplicatePolicy: '1',
    ReturnVerifyCode: 'false',
  }, fetchImpl);
}

export async function checkPnvsCode(bindings: AppBindings, phone: string, code: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const result = await requestPnvs(bindings, 'CheckSmsVerifyCode', { PhoneNumber: phone, VerifyCode: code }, fetchImpl);
  return result.Model?.VerifyResult === 'PASS';
}
