import { currentAccount } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function Login() {
  const account = await currentAccount();
  return <main className="account-page"><section className="account-panel"><span className="account-mark">S</span><small>SKUFlow AI</small><h1>{account ? '你的账号' : '登录 SKUFlow'}</h1><p>{account ? '当前已通过 ChatGPT 身份认证。' : '使用 ChatGPT 账号登录，继续创建商品上新任务。你的会话、资料与任务会保存在自己的账号下。'}</p>{account ? <><dl><dt>姓名</dt><dd>{account.name}</dd><dt>邮箱</dt><dd>{account.email}</dd><dt>登录方式</dt><dd>ChatGPT</dd></dl><a className="account-primary" href="/">返回工作台</a><a className="account-secondary" href="/signout-with-chatgpt?return_to=/login" target="_top">退出登录</a></> : <a className="account-primary" href="/signin-with-chatgpt?return_to=/" target="_top">使用 ChatGPT 登录</a>}<small className="account-note">{process.env.NODE_ENV === 'development' ? '本地开发环境使用模拟身份；线上使用真实账号认证。' : '身份认证由 ChatGPT 提供，SKUFlow 不接收你的账号密码。'}</small></section></main>;
}
