import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "Von — admin",
  description: "Tenants, apps, provisioning and releases",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            von
          </Link>
          {/* Gapped rather than relying on JSX whitespace, which collapses
              between elements and renders the two links as one word. */}
          <nav style={{ display: "flex", gap: 16 }}>
            <Link href="/apps">Apps</Link>
            <Link href="/fleet">Fleet</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
