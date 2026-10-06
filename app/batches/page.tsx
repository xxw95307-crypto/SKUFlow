import { currentAccount } from '@/lib/server/auth';
import { redirect } from 'next/navigation';
import { AgentConversation } from '@/components/agent-conversation';

export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  const account = await currentAccount();
  if (!account) redirect('/login?next=%2Fbatches');
  return <AgentConversation account={account} initialWorkspace="batch" />;
}
