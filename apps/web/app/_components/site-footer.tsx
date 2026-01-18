import Link from "next/link";

type SiteFooterProps = Readonly<{
  githubUrl: string;
}>;

export function SiteFooter({ githubUrl }: SiteFooterProps) {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div>
          <Link className="brand brand--footer" href="/">
            SnapFlow
          </Link>
          <p>From captured notes to approved actions.</p>
        </div>

        <nav className="footer-nav" aria-label="Footer navigation">
          <Link href="/demo">Workspace</Link>
          <Link href="/engineering">Engineering</Link>
          <Link href="/privacy">Privacy</Link>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>

        <p className="footer-status">
          <span aria-hidden="true" />
          Mock-first by design
        </p>
      </div>
    </footer>
  );
}
