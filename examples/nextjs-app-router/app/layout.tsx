import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AllStak Next.js App Router Example',
  description: 'Demonstrates @allstak/next SDK integration with Next.js App Router',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '2rem' }}>
        {children}
      </body>
    </html>
  );
}
