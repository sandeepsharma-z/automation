import { Space_Grotesk, IBM_Plex_Serif } from 'next/font/google';
import './globals.css';

const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-ui' });
const serif = IBM_Plex_Serif({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-serif' });

export const metadata = {
  title: 'ContentOps AI Admin',
  description: 'Research-driven content operations console',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${serif.variable}`}>{children}</body>
    </html>
  );
}
