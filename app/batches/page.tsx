import { currentAccount } from '@/lib/server/auth';
import { redirect } from 'next/navigation';
import { BatchWorkspace } from '@/components/batch-workspace';

export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  if (!await currentAccount()) redirect('/login?next=%2Fbatches');
  return <BatchWorkspace />;
}
