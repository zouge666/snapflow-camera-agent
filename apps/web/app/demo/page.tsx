import type { Metadata } from "next";

import { northstarPlanningSample } from "../../features/ocr-review/sample-review";
import { WorkflowDemo } from "../../features/workflow/workflow-demo";

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
            Human review checkpoint
          </p>
          <h1>Fix the text before AI turns it into work.</h1>
        </div>
        <p>
          Start with a synthetic meeting image and its fixture transcript. Confirm the
          text, then ask the deterministic demo API to return traceable candidate
          actions.
        </p>
      </div>

      <WorkflowDemo sample={northstarPlanningSample} />
    </main>
  );
}
