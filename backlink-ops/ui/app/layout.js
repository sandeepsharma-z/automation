import "./globals.css";
import Link from "next/link";
import RecoveryFlagClearer from "./recovery-flag-clearer";
import EmbedMode from "./embed-mode";

export const metadata = {
  title: "Backlink Operations",
  description: "Compliant human-in-loop backlink submission operations",
};

const NAV = [
  { href: "/backlinks/intake",       label: "Fill Details",      icon: "📝" },
  { href: "/backlinks/ops-entry",    label: "Blog Commenting",   icon: "💬" },
  { href: "/backlinks/finder",       label: "Backlinks Finder",  icon: "🔍" },
  { href: "/backlinks/table",        label: "Status Table",      icon: "📊" },
  { href: "/backlinks/bulk-runs",    label: "Bulk Runs",         icon: "⚡" },
  { href: "/backlinks/success-vault",label: "Success Vault",     icon: "✅" },
];

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <EmbedMode />
        <RecoveryFlagClearer />
        <div className="shell">
          <aside className="sidebar">
            <h1>Backlink Ops</h1>
            <div className="muted" style={{ marginBottom: 20 }}>AI-powered · Human approved</div>
            <nav className="nav">
              {NAV.map(({ href, label, icon }) => (
                <Link key={href} href={href}>
                  <span style={{ fontSize: 15 }}>{icon}</span> {label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
