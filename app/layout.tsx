import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '旅する書斎 秘書ダッシュボード',
  description: 'Tabisuru Shosai Secretary Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="bg-bg text-text-primary font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
