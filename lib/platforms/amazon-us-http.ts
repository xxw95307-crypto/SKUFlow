/** Headers required for every SP-API request; fetch supplies the Host header. */
export function amazonSpApiHeaders(accessToken: string, now = new Date()): Record<string, string> {
  return {
    'x-amz-access-token': accessToken,
    'x-amz-date': now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'user-agent': 'SKUFlowAI/0.1 (Language=TypeScript)',
    accept: 'application/json',
  };
}
