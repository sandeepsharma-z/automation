import "./globals.css";
import Link from "next/link";
import RecoveryFlagClearer from "./recovery-flag-clearer";
import EmbedMode from "./embed-mode";

export const metadata = {
  title: "Backlink Operations",
  description: "Compliant human-in-loop backlink submission operations",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <EmbedMode />
        <RecoveryFlagClearer />
        <div className="shell">
          <aside className="sidebar">
            <h1>Backlink Operations</h1>
            <div className="muted">Compliant flow only. Human approval required before submit.</div>
            <nav className="nav" style={{ marginTop: 16 }}>
              <Link href="/backlinks/intake">Fill Details</Link>
              <Link href="/backlinks/table">Status Table</Link>
              <Link href="/backlinks/finder">Backlinks Finder</Link>
              <Link href="/backlinks/bulk-runs">Bulk Runs</Link>
              <Link href="/backlinks/success-vault">Success Vault</Link>
            </nav>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
