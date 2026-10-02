import { currentAccount } from '@/lib/server/auth';
import { AuthForm, AccountProfile } from '@/components/auth-form';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const account = await currentAccount();
  const { error } = await searchParams;
  return <main className="account-page"><section className="account-panel">
    <span className="account-mark">S</span><small>SKUFlow AI</small>
    {account ? <AccountProfile account={account} /> : <AuthForm wechatError={Boolean(error)} />}
  </section></main>;
}
