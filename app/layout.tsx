import type { Metadata } from 'next';
import './globals.css';
import './agent-workspace.css';

export const metadata: Metadata = {
  title: 'SKUFlow AI｜跨境商品智能上新',
  description: '由 Agent 自动理解商品资料、生成多平台 Listing，并在冲突、选图和发布节点请商家确认。',
  openGraph: {
    title: 'SKUFlow AI｜跨境商品智能上新',
    description: '一次对话，由 Agent 自动完成多平台商品上新。',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SKUFlow AI 多平台商品上新流程' }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
