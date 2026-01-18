import Link from "next/link";

type SiteHeaderProps = Readonly<{
  githubUrl: string;
}>;

export function SiteHeader({ githubUrl }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="SnapFlow home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>SnapFlow</span>
        </Link>

        <nav className="primary-nav" aria-label="Primary navigation">
          <Link href="/demo">Workspace</Link>
          <Link href="/engineering">Engineering</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>

        <a
          className="source-link source-link--header"
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
        >
          Source
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </header>
  );
}
