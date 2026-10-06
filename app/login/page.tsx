import { currentAccount } from '@/lib/server/auth';
import { AuthForm, AccountProfile } from '@/components/auth-form';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const account = await currentAccount();
  const { error, next } = await searchParams;
  const destination = next === '/batches' ? '/batches' : '/';
  if (account && destination !== '/') redirect(destination);
  return <main className="account-page"><section className="account-panel">
    <div className="account-panel-content">
      <span className="account-mark" aria-label="SKUFlow">S</span>
      {account ? <AccountProfile account={account} /> : <AuthForm wechatError={Boolean(error)} next={destination} />}
    </div>
    <div className="account-panel-visual" aria-hidden="true" />
  </section></main>;
}
