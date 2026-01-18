import type { Metadata } from "next";

import { getPublicConfig } from "../public-config";

export const metadata: Metadata = {
  title: "Engineering",
  description: "Verified engineering evidence behind the SnapFlow workflow.",
};

const verifiedFoundations = [
  {
    label: "Quality gates",
    value: "Web + API",
    copy: "Formatting, lint, strict types, unit tests, coverage and production build run in CI.",
  },
  {
    label: "Provider boundary",
    value: "Mock only",
    copy: "The current API rejects any non-mock provider instead of silently calling a real model.",
  },
  {
    label: "Local runtime",
    value: "API + Postgres",
    copy: "A health-checked Compose baseline uses fixed image digests and loopback-only ports.",
  },
] as const;

export default function EngineeringPage() {
  const { githubUrl } = getPublicConfig();

  return (
    <main id="main-content" className="info-page page-width" tabIndex={-1}>
      <header className="page-intro">
        <div>
          <p className="eyebrow">
            <span aria-hidden="true" />
            Engineering evidence
          </p>
          <h1>Architecture claims should come with a test result.</h1>
        </div>
        <div className="intro-aside">
          <p>
            This page only lists foundations already present in the repository. Workflow
            traces and evaluation metrics will appear after they are measured.
          </p>
          <a href={githubUrl} target="_blank" rel="noreferrer">
            Inspect the source <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <section className="evidence-grid" aria-label="Verified foundations">
        {verifiedFoundations.map((foundation) => (
          <article key={foundation.label}>
            <span>{foundation.label}</span>
            <strong>{foundation.value}</strong>
            <p>{foundation.copy}</p>
          </article>
        ))}
      </section>

      <section className="architecture-card" aria-labelledby="architecture-title">
        <div className="architecture-copy">
          <p className="section-kicker">Current build boundary</p>
          <h2 id="architecture-title">A modular shell before an agent workflow.</h2>
          <p>
            The browser, API and local database are separated now so future extraction,
            checkpoint and approval work can be added without turning the project into a
            framework demo.
          </p>
        </div>

        <div className="architecture-flow" aria-label="Current system flow">
          <div>
            <span>Browser</span>
            <strong>Next.js shell</strong>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <span>API</span>
            <strong>FastAPI boundary</strong>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <span>Provider</span>
            <strong>Mock only</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
