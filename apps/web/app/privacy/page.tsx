import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy",
  description: "The current and planned data boundaries for SnapFlow.",
};

export default function PrivacyPage() {
  return (
    <main id="main-content" className="info-page page-width" tabIndex={-1}>
      <header className="page-intro">
        <div>
          <p className="eyebrow">
            <span aria-hidden="true" />
            Privacy-aware by architecture
          </p>
          <h1>Keep the image local. Make every data handoff visible.</h1>
        </div>
        <div className="intro-aside">
          <p>
            The current product shell does not capture, upload or save meeting content.
            This page records the boundary the working demo must keep as those
            capabilities are added.
          </p>
        </div>
      </header>

      <section className="privacy-now" aria-labelledby="privacy-now-title">
        <span className="status-pill status-pill--review">Current shell</span>
        <div>
          <h2 id="privacy-now-title">No meeting data is processed yet.</h2>
          <p>
            Opening the workspace creates no run and makes no model request. Disabled
            controls are intentionally shown as disabled.
          </p>
        </div>
      </section>

      <section className="privacy-grid" aria-label="Planned data boundaries">
        <article>
          <span>01</span>
          <h2>Image</h2>
          <p>
            Crop, resize and OCR in the browser. Do not send image bytes or base64 to
            the API.
          </p>
        </article>
        <article>
          <span>02</span>
          <h2>Reviewed text</h2>
          <p>
            Send text only after the user can inspect and correct the transcript and
            confirm the handoff.
          </p>
        </article>
        <article>
          <span>03</span>
          <h2>Workflow state</h2>
          <p>
            Keep short-lived run metadata for recovery, with deletion and retention
            behaviour tested separately.
          </p>
        </article>
      </section>

      <section className="privacy-note" aria-labelledby="privacy-note-title">
        <p className="section-kicker">Plain-language limit</p>
        <h2 id="privacy-note-title">Privacy-aware is not a compliance claim.</h2>
        <p>
          Provider retention, cloud backups and regional processing must be measured and
          disclosed before a real model or production database is enabled.
        </p>
      </section>
    </main>
  );
}
