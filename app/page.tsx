import { AgentConversation } from '@/components/agent-conversation';
import { currentAccount } from '@/lib/server/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const account = await currentAccount();
  if (!account) redirect('/login');
  return <AgentConversation account={account} />;
}
