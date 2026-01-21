import type { AxeResults, RunOptions } from "axe-core";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "../app/_components/site-footer";
import { SiteHeader } from "../app/_components/site-header";
import DemoPage from "../app/demo/page";
import HomePage from "../app/page";

const githubUrl = "https://github.com/example/snapflow";

describe("product shell", () => {
  it("puts the value proposition, CTA and public routes on the landing page", () => {
    const markup = renderToStaticMarkup(
      <>
        <SiteHeader githubUrl={githubUrl} />
        <HomePage />
      </>,
    );

    expect(markup).toContain("Turn meeting notes into actions you can trust.");
    expect(markup).toContain('href="/demo"');
    expect(markup).toContain('href="/engineering"');
    expect(markup).toContain('href="/privacy"');
    expect(markup).not.toMatch(/pricing|early access/i);
  });

  it("renders a four-step workspace at the review checkpoint", () => {
    const markup = renderToStaticMarkup(<DemoPage />);

    expect(markup.match(/<li(?:\s|>)/g)).toHaveLength(4);
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain("Human review checkpoint");
    expect(markup).toContain("Review the sample transcript");
    expect(markup).not.toContain("Use camera");
  });

  it("uses the injected source URL in shared navigation", () => {
    const markup = renderToStaticMarkup(<SiteHeader githubUrl={githubUrl} />);

    expect(markup).toContain(`href="${githubUrl}"`);
  });

  it("has no automatic axe violations in the landing shell", async () => {
    const markup = renderToStaticMarkup(
      <>
        <SiteHeader githubUrl={githubUrl} />
        <HomePage />
        <SiteFooter githubUrl={githubUrl} />
      </>,
    );
    const dom = new JSDOM(
      `<!doctype html><html lang="en"><head><title>SnapFlow test shell</title></head><body>${markup}</body></html>`,
      {
        pretendToBeVisual: true,
        runScripts: "outside-only",
        url: "http://localhost:3000/",
      },
    );

    dom.window.eval(axe.source);
    const axeWindow = dom.window as unknown as {
      axe: {
        run: (document: Document, options: RunOptions) => Promise<AxeResults>;
      };
    };
    const results = await axeWindow.axe.run(dom.window.document, {
      rules: { "color-contrast": { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
