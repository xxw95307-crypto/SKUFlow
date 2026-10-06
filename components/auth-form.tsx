'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { AccountIdentity } from '@/lib/domain/identity';

type Mode = 'password' | 'sms' | 'register';
type Status = { sms: boolean; wechat: boolean };

async function postJson(url: string, body: Record<string, string>): Promise<void> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || '操作失败，请稍后再试');
}

function useAuthStatus(): Status {
  const [status, setStatus] = useState<Status>({ sms: false, wechat: false });
  useEffect(() => { void fetch('/api/auth/status').then((response) => response.json() as Promise<Status>).then((value) => setStatus(value)).catch(() => undefined); }, []);
  return status;
}

function useCooldown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!seconds) return;
    const timer = window.setTimeout(() => setSeconds(seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return [seconds, setSeconds] as const;
}

export function AuthForm({ wechatError = false, next = '/' }: { wechatError?: boolean; next?: string }) {
  const [mode, setMode] = useState<Mode>('password');
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [seconds, setSeconds] = useCooldown();
  const status = useAuthStatus();

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'register') await postJson('/api/auth/register', { username, password });
      else if (mode === 'password') await postJson('/api/auth/password-login', { identifier, password });
      else await postJson('/api/auth/sms-login', { phone, code });
      window.location.assign(next === '/batches' ? '/batches' : '/');
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const sendCode = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await postJson('/api/auth/sms/send', { phone });
      setSeconds(60);
      setNotice('验证码已发送，5 分钟内有效');
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  return <>
    <h1>{mode === 'register' ? '创建账号' : '欢迎回来'}</h1>
    <div className="auth-tabs" role="tablist" aria-label="登录方式">
      <button type="button" role="tab" aria-selected={mode === 'password'} className={mode === 'password' ? 'active' : ''} onClick={() => { setMode('password'); setError(''); }}>密码登录</button>
      <button type="button" role="tab" aria-selected={mode === 'sms'} className={mode === 'sms' ? 'active' : ''} onClick={() => { setMode('sms'); setError(''); }}>短信登录</button>
      <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>注册账号</button>
    </div>
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      {mode === 'password' && <>
        <label>用户名或手机号<input autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required placeholder="输入用户名或手机号" /></label>
        <label>密码<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="输入密码" /></label>
      </>}
      {mode === 'register' && <>
        <label>用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} pattern="[A-Za-z][A-Za-z0-9_]{3,29}" required placeholder="4–30 位字母、数字或下划线" /></label>
        <label>密码<input autoComplete="new-password" type="password" minLength={10} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="至少 10 个字符" /></label>
      </>}
      {mode === 'sms' && <>
        <label>中国大陆手机号<input autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required placeholder="输入手机号" /></label>
        <label>短信验证码<div className="auth-code-row"><input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required placeholder="6 位验证码" /><button type="button" disabled={busy || seconds > 0 || !status.sms} onClick={() => void sendCode()}>{seconds ? `${seconds} 秒` : '获取验证码'}</button></div></label>
        {!status.sms && <small className="auth-helper">短信服务暂不可用</small>}
      </>}
      {wechatError && <p className="auth-error" role="alert">微信授权未完成，请重新尝试。</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      <button className="account-primary" disabled={busy || (mode === 'sms' && !status.sms)}>{busy ? '请稍候…' : mode === 'register' ? '注册并登录' : '登录'}</button>
    </form>
    {status.wechat && <a className="account-secondary" href="/api/auth/wechat/start">微信扫码登录</a>}
    <a className="account-secondary" href={`/signin-with-chatgpt?return_to=${encodeURIComponent(next === '/batches' ? next : '/')}`} target="_top">使用 ChatGPT 登录</a>
  </>;
}

export function AccountProfile({ account }: { account: AccountIdentity }) {
  const status = useAuthStatus();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useCooldown();
  const logout = async () => {
    setBusy(true); setError('');
    try { await postJson('/api/auth/logout', {}); window.location.assign('/login'); }
    catch (caught) { setError((caught as Error).message); setBusy(false); }
  };
  const sendCode = async () => {
    setBusy(true); setError('');
    try { await postJson('/api/auth/sms/send', { phone }); setSeconds(60); setNotice('验证码已发送'); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  const bind = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await postJson('/api/auth/phone/bind', { phone, code }); window.location.reload(); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <h1>你的账号</h1>
    <p>任务、资料和生成结果只对这个账号可见。</p>
    <dl><dt>名称</dt><dd>{account.name}</dd>{account.username && <><dt>用户名</dt><dd>{account.username}</dd></>}{account.phone && <><dt>手机号</dt><dd>{account.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')}</dd></>}{account.email && <><dt>邮箱</dt><dd>{account.email}</dd></>}<dt>登录方式</dt><dd>{account.provider === 'local' ? 'SKUFlow 账号' : 'ChatGPT'}</dd></dl>
    {account.provider === 'local' && !account.phone && status.sms && <form className="auth-form auth-bind-form" onSubmit={(event) => void bind(event)}><h2>绑定手机号</h2><p>绑定后可以使用短信验证码登录这个账号。</p><label>手机号<input autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} required /></label><label>验证码<div className="auth-code-row"><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} required /><button type="button" disabled={busy || seconds > 0} onClick={() => void sendCode()}>{seconds ? `${seconds} 秒` : '获取验证码'}</button></div></label>{error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="auth-notice">{notice}</p>}<button className="account-primary" disabled={busy}>绑定手机号</button></form>}
    <Link className="account-primary" href="/">返回工作台</Link>
    {error && !(!account.phone && status.sms) && <p className="auth-error" role="alert">{error}</p>}
    {account.provider === 'local' ? <button className="account-secondary" type="button" disabled={busy} onClick={() => void logout()}>退出登录</button> : <a className="account-secondary" href="/signout-with-chatgpt?return_to=/login" target="_top">退出登录</a>}
  </>;
}
