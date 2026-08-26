import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SKUFlow AI｜跨境商品智能上新',
  description: '把一份商品原始资料编译为多平台、多语言的可审核上架包。',
  openGraph: {
    title: 'SKUFlow AI｜跨境商品智能上新',
    description: '一份商品资料，编译成多平台上架包。',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'SKUFlow AI 多平台商品上新流程' }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
