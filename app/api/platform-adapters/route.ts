import { withAuthentication } from '@/lib/server/auth';
import { platformAdapterRegistry } from '@/lib/platform-sdk';

export const dynamic = 'force-dynamic';

async function handleGET() {
  const adapters = platformAdapterRegistry.list();
  return Response.json({
    sdkVersion: '1.0.0',
    interfaceVersion: '1.0',
    adapters,
    coverage: platformAdapterRegistry.coverage(),
    rules: adapters.map((adapter) => platformAdapterRegistry.get(adapter.id)?.rules).filter(Boolean),
  });
}

export const GET = withAuthentication(handleGET);
