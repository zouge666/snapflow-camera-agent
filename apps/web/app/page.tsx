import Link from "next/link";

import { getPublicConfig } from "./public-config";

const workflowSteps = [
  {
    number: "01",
    title: "Capture on device",
    copy: "Bring in a whiteboard or notebook without making the image part of the server workflow.",
  },
  {
    number: "02",
    title: "Review the text",
    copy: "Correct the transcript before any meeting content can move to the action workflow.",
  },
  {
    number: "03",
    title: "Approve every action",
    copy: "Check the evidence, owner and date. Nothing is exported without a human decision.",
  },
  {
    number: "04",
    title: "Export the approved set",
    copy: "Create calendar-ready and Markdown output from the items you chose to keep.",
  },
] as const;

export default function HomePage() {
  const { githubUrl } = getPublicConfig();

  return (
    <main id="main-content" tabIndex={-1}>
      <section className="hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">
            <span aria-hidden="true" />
            Camera-to-action workflow
          </p>
          <h1 id="hero-title">Turn meeting notes into actions you can trust.</h1>
          <p className="hero-summary">
            SnapFlow turns a photo of meeting notes into traceable, human-approved
            action items—without letting the model skip the review.
          </p>
          <div className="hero-actions">
            <Link className="button button--primary" href="/demo">
              Open the workspace
              <span aria-hidden="true">→</span>
            </Link>
            <a
              className="button button--quiet"
              href={githubUrl}
              target="_blank"
              rel="noreferrer"
            >
              View source
              <span aria-hidden="true">↗</span>
            </a>
          </div>
          <ul className="guardrail-list" aria-label="Workflow guardrails">
            <li>On-device image boundary</li>
            <li>Evidence-linked output</li>
            <li>Approval before export</li>
          </ul>
        </div>

        <div className="workflow-preview" aria-label="Workflow interface preview">
          <div className="preview-topbar">
            <div>
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
            </div>
            <span>Interface preview</span>
          </div>

          <div className="note-panel">
            <div className="panel-heading">
              <span>Reviewed note</span>
              <span className="status-pill status-pill--neutral">Text only</span>
            </div>
            <blockquote>
              “Alex drafts the launch checklist by Friday. Confirm the final time before
              adding it to the calendar.”
            </blockquote>
            <div className="evidence-line">
              <span />
              Evidence kept with the action
            </div>
          </div>

          <div className="flow-connector" aria-hidden="true">
            <span>Extract</span>
            <span>↓</span>
          </div>

          <article className="action-preview">
            <div className="panel-heading">
              <span>Action 01</span>
              <span className="status-pill status-pill--review">Needs review</span>
            </div>
            <h2>Draft the launch checklist</h2>
            <dl className="action-fields">
              <div>
                <dt>Owner</dt>
                <dd>Alex</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>Friday · time missing</dd>
              </div>
            </dl>
            <div className="approval-row">
              <span className="model-boundary">
                <span aria-hidden="true" /> Demo provider
              </span>
              <span className="approval-button">Approve</span>
            </div>
          </article>
        </div>
      </section>

      <section className="workflow-section page-width" aria-labelledby="flow-title">
        <div className="section-heading">
          <p className="section-kicker">A controlled path</p>
          <h2 id="flow-title">The model proposes. You decide what moves.</h2>
          <p>
            Each step creates a visible boundary between untrusted input, probabilistic
            output and an approved side effect.
          </p>
        </div>

        <ol className="workflow-grid">
          {workflowSteps.map((step) => (
            <li key={step.number}>
              <span>{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="principles-section" aria-labelledby="principles-title">
        <div className="principles-inner page-width">
          <div>
            <p className="section-kicker section-kicker--light">
              Built for the review step
            </p>
            <h2 id="principles-title">
              Useful AI should show its work—and know where to stop.
            </h2>
          </div>
          <div className="principle-list">
            <article>
              <span>01 / Evidence</span>
              <h3>Keep the source close</h3>
              <p>
                Every proposed action is designed to point back to the text that
                supports it.
              </p>
            </article>
            <article>
              <span>02 / Control</span>
              <h3>Pause before side effects</h3>
              <p>
                Clarification and approval are workflow states, not suggestions hidden
                in a prompt.
              </p>
            </article>
            <article>
              <span>03 / Honesty</span>
              <h3>Make the boundary visible</h3>
              <p>
                Demo output stays labelled, and unmeasured quality is never presented as
                a result.
              </p>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
