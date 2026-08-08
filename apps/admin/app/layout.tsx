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
          <nav>
            <Link href="/apps">Apps</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
