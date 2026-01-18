import type { Metadata } from "next";
import Link from "next/link";

import { DemoStepper } from "../_components/demo-stepper";

export const metadata: Metadata = {
  title: "Workspace",
  description: "The SnapFlow camera-to-action workspace.",
};

export default function DemoPage() {
  return (
    <main id="main-content" className="workspace-page page-width" tabIndex={-1}>
      <div className="page-intro page-intro--workspace">
        <div>
          <p className="eyebrow">
            <span aria-hidden="true" />
            Product shell preview
          </p>
          <h1>Build an action plan from what the meeting left behind.</h1>
        </div>
        <p>
          Capture controls are not enabled in this milestone. This workspace shows the
          review path without pretending a workflow has run.
        </p>
      </div>

      <DemoStepper />

      <div className="workspace-grid">
        <section className="capture-shell" aria-labelledby="capture-title">
          <div className="workspace-card-heading">
            <div>
              <span>Step 01</span>
              <h2 id="capture-title">Add your meeting notes</h2>
            </div>
            <span className="status-pill status-pill--neutral">Not started</span>
          </div>

          <div className="capture-stage">
            <div className="capture-corners" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="capture-glyph" aria-hidden="true">
              <span />
            </div>
            <h3>Camera and upload controls arrive next</h3>
            <p id="capture-help">
              The finished flow will process the image in your browser before you review
              any extracted text.
            </p>
            <div className="capture-actions" aria-describedby="capture-help">
              <button type="button" disabled>
                Use camera
              </button>
              <button type="button" disabled>
                Upload image
              </button>
            </div>
          </div>
        </section>

        <aside className="run-boundary" aria-labelledby="boundary-title">
          <div>
            <p className="section-kicker">Current boundary</p>
            <h2 id="boundary-title">Nothing has left this browser.</h2>
            <p>
              This is an interface shell. There is no image, transcript, model call or
              saved run yet.
            </p>
          </div>
          <dl>
            <div>
              <dt>Provider</dt>
              <dd>
                <span className="boundary-dot" aria-hidden="true" /> Demo only
              </dd>
            </div>
            <div>
              <dt>Image</dt>
              <dd>Not selected</dd>
            </div>
            <div>
              <dt>Run state</dt>
              <dd>Not created</dd>
            </div>
          </dl>
          <Link href="/privacy">Read the data boundary →</Link>
        </aside>
      </div>
    </main>
  );
}
