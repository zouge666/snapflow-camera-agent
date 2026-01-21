import type { Metadata } from "next";

import { ReviewTextForm } from "../../features/ocr-review/review-text-form";
import { northstarPlanningSample } from "../../features/ocr-review/sample-review";
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
            Human review checkpoint
          </p>
          <h1>Fix the text before AI turns it into work.</h1>
        </div>
        <p>
          Start with a synthetic meeting image and its fixture transcript. Edit the text
          and context, then explicitly confirm what the next step may use.
        </p>
      </div>

      <DemoStepper currentStep={1} />
      <ReviewTextForm sample={northstarPlanningSample} />
    </main>
  );
}
