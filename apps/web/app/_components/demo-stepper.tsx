const steps = [
  { label: "Capture", detail: "Add your notes" },
  { label: "Review text", detail: "Correct the transcript" },
  { label: "Review actions", detail: "Approve each item" },
  { label: "Export", detail: "Download approved work" },
] as const;

type DemoStepperProps = Readonly<{
  currentStep?: number;
}>;

export function DemoStepper({ currentStep = 0 }: DemoStepperProps) {
  return (
    <nav className="demo-stepper" aria-label="Demo progress">
      <ol>
        {steps.map((step, index) => (
          <li
            className={index === currentStep ? "is-current" : undefined}
            key={step.label}
            aria-current={index === currentStep ? "step" : undefined}
          >
            <span className="step-number" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
