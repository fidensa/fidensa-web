import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Fidensa",
    template: "%s | Fidensa",
  },
  description: "Fidensa website foundation.",
  robots: {
    index: false,
    follow: false,
  },
};

// A request-bound render is required so Next.js applies the per-response CSP nonce.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="site-header">
          <Link className="site-name" href="/">
            Fidensa
          </Link>
          <nav className="site-nav" aria-label="Primary navigation">
            <ul>
              <li>
                <Link href="/apply">Apply</Link>
              </li>
              <li>
                <Link href="/privacy">Privacy</Link>
              </li>
              <li>
                <Link href="/evidence">Evidence status</Link>
              </li>
            </ul>
          </nav>
        </header>
        <main id="main-content">{children}</main>
        <footer className="site-footer">
          <p>Foundation preview. Content and workflows are not final.</p>
        </footer>
      </body>
    </html>
  );
}
