import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

test("sample review reaches a durable partial server approval without a key", async ({
  page,
}) => {
  const unexpectedOrigins = new Set<string>();
  const browserOrigin = "http://127.0.0.1:3100";

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== browserOrigin) {
        unexpectedOrigins.add(url.origin);
      }
    }
  });

  await page.goto("/demo");

  await expect(
    page.getByRole("heading", { name: "Review the sample transcript" }),
  ).toBeVisible();
  await expect(page.getByText("Synthetic sample", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Meeting text")).toHaveValue(
    /Northstar weekly planning/,
  );
  await expect(page.getByText("Demo provider", { exact: true }).first()).toBeVisible();

  await page
    .getByRole("checkbox", {
      name: "I reviewed this text and want to use it in the next step.",
    })
    .check();
  await page.getByRole("button", { name: "Confirm reviewed text" }).click();
  await expect(page.getByText("Text confirmed locally.")).toBeVisible();

  const runRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/runs",
  );
  await page.getByRole("button", { name: "Build demo action plan" }).click();
  const runRequest = await runRequestPromise;
  const runPayload = runRequest.postDataJSON() as Record<string, unknown>;

  expect(runPayload).toMatchObject({
    schema_version: "1.0",
    locale: "en-US",
    timezone: "Europe/Copenhagen",
    reference_date: "2026-01-15",
  });
  expect(runRequest.headers()["idempotency-key"]).toMatch(/^create-run:/);
  expect(JSON.stringify(runPayload)).not.toMatch(/image|base64|data:image/i);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        sessionKeys: Object.keys(window.sessionStorage)
          .filter((key) => key.startsWith("snapflow."))
          .sort(),
        persistentKeys: Object.keys(window.localStorage).filter((key) =>
          key.startsWith("snapflow."),
        ),
      })),
    )
    .toEqual({
      sessionKeys: ["snapflow.active-run.v1", "snapflow.guest-session.v1"],
      persistentKeys: [],
    });

  await expect(
    page.getByRole("heading", {
      name: "What date is the pilot review for the support FAQ deadline?",
    }),
  ).toBeVisible();
  await expect(
    page.locator("blockquote").filter({ hasText: "before the pilot review" }),
  ).toBeVisible();

  const refreshResume = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/resume"),
  );
  await page.reload();
  await refreshResume;
  await expect(
    page.getByRole("heading", {
      name: "What date is the pilot review for the support FAQ deadline?",
    }),
  ).toBeVisible();

  const clarificationRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/clarifications"),
  );
  await page.getByLabel("Your answer").fill("2026-01-22");
  await page.getByRole("button", { name: "Resume this run" }).click();
  const clarificationRequest = await clarificationRequestPromise;
  expect(clarificationRequest.postDataJSON()).toEqual({
    schema_version: "1.0",
    clarification_id: "clarification-1",
    kind: "free_text",
    answer: "2026-01-22",
  });

  await expect(
    page.getByRole("heading", { name: "Decide each candidate separately." }),
  ).toBeVisible();
  const reviews = page.getByRole("list", { name: "Candidate action reviews" });
  await expect(reviews.getByRole("listitem")).toHaveCount(3);

  const submitButton = page.getByRole("button", {
    name: "Submit decisions to server",
  });
  await expect(submitButton).toBeDisabled();

  const checklist = reviews
    .getByRole("listitem")
    .filter({ hasText: "Send the revised onboarding checklist" });
  const supportFaq = reviews
    .getByRole("listitem")
    .filter({ hasText: "Prepare the support FAQ" });
  const pilotReview = reviews
    .getByRole("listitem")
    .filter({ hasText: "Book a 30-minute pilot review" });

  await checklist.getByRole("button", { name: "Approve" }).click();
  await supportFaq.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("1 approved", { exact: true })).toBeVisible();
  await expect(page.getByText("1 rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(submitButton).toBeDisabled();
  await pilotReview.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("2 rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("0 pending", { exact: true })).toBeVisible();
  await expect(submitButton).toBeEnabled();

  const approvalRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/approval"),
  );
  await submitButton.click();
  const approvalRequest = await approvalRequestPromise;
  const approvalPayload = approvalRequest.postDataJSON() as {
    decisions: readonly Record<string, unknown>[];
  };

  expect(approvalRequest.headers()["idempotency-key"]).toMatch(/^approve-run:/);
  expect(approvalPayload.decisions).toEqual([
    { action_id: "action-1", decision: "approve", reviewed: null },
    { action_id: "action-2", decision: "reject", reviewed: null },
    { action_id: "action-3", decision: "reject", reviewed: null },
  ]);
  expect(JSON.stringify(approvalPayload)).not.toMatch(/evidence|quote|source_text/i);
  await expect(
    page.getByRole("heading", { name: "Your decisions are saved." }),
  ).toBeVisible();
  await expect(page.getByText(/1 approved and 2 rejected/)).toBeVisible();
  await expect(
    page.getByText("Export has not started.", { exact: false }),
  ).toBeVisible();

  const approvedRefresh = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/resume"),
  );
  await page.reload();
  await approvedRefresh;
  await expect(
    page.getByRole("heading", { name: "Your decisions are saved." }),
  ).toBeVisible();
  await expect(page.getByText(/1 approved and 2 rejected/)).toBeVisible();
  expect([...unexpectedOrigins]).toEqual([]);
});

test("a local image can be cropped and reset without an image upload", async ({
  page,
}) => {
  const postRequests: Array<Readonly<{ url: string; body: string | null }>> = [];

  page.on("request", (request) => {
    if (request.method() === "POST") {
      postRequests.push({
        url: request.url(),
        body: request.postData(),
      });
    }
  });

  await page.goto("/demo");
  await page
    .locator('.camera-access-actions input[type="file"]')
    .setInputFiles(
      resolve("apps/web/public/samples/northstar-planning/meeting-notes.png"),
    );

  await expect(page.getByRole("heading", { name: "Review this image." })).toBeVisible();
  await expect(
    page.getByText("The image stays on this device and has not been sent to the API."),
  ).toBeVisible();
  await expect(
    page.getByAltText("Selected meeting notes awaiting confirmation"),
  ).toHaveAttribute("src", /^blob:/);
  await expect(page.getByText("1600 × 1000", { exact: true })).toBeVisible();

  await page.getByLabel("Crop").selectOption("square");
  await expect(page.getByText("1000 × 1000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rotate right" }).click();
  await expect(
    page.getByText("Preview re-encoded locally. Metadata removed."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset image" }).click();
  await expect(page.getByText("1600 × 1000", { exact: true })).toBeVisible();

  expect(postRequests).toEqual([]);
});

test("camera denial keeps the upload and synthetic sample fallbacks available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        throw new DOMException("blocked for deterministic test", "NotAllowedError");
      },
    });
  });
  await page.goto("/demo");

  await page.getByRole("button", { name: "Use camera" }).click();

  await expect(page.getByText("Camera access was blocked.")).toBeVisible();
  await expect(page.getByText("Choose image", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review selected sample" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Review the sample transcript" }),
  ).toBeVisible();
});

test("an uploaded image recovers from worker failure and sends only final text", async ({
  page,
}) => {
  const browserOrigin = "http://127.0.0.1:3100";
  const unexpectedOrigins = new Set<string>();
  let failWorkerOnce = true;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== browserOrigin
    ) {
      unexpectedOrigins.add(url.origin);
    }
  });
  await page.route("**/ocr-runtime/worker.min.js", async (route) => {
    if (failWorkerOnce) {
      failWorkerOnce = false;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.goto("/demo");
  await page
    .locator('.camera-access-actions input[type="file"]')
    .setInputFiles(
      resolve("apps/web/public/samples/northstar-planning/meeting-notes.png"),
    );

  await page.getByRole("button", { name: "Read text on this device" }).click();
  await expect(page.getByText("OCR could not finish.")).toBeVisible();
  await page.getByRole("button", { name: "Retry local OCR" }).click();
  await expect(
    page.getByRole("heading", { name: "Review the OCR transcript" }),
  ).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Uploaded image OCR", { exact: true })).toBeVisible();

  const fixtureTranscript = await readFile(
    resolve("apps/web/public/samples/northstar-planning/transcript.txt"),
    "utf8",
  );
  const finalText = `${fixtureTranscript.trimEnd()}\nReviewed locally ✓`;
  await page.getByLabel("Meeting text").fill(finalText);
  await expect(page.getByText("Unsaved edits", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Original confidence links are paused", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Locale").fill("en-US");
  await page.getByLabel("Timezone").fill("Europe/Copenhagen");
  await page.getByLabel("Reference date").fill("2026-01-15");

  await page
    .getByRole("checkbox", {
      name: "I reviewed this text and want to use it in the next step.",
    })
    .check();
  await page.getByRole("button", { name: "Confirm reviewed text" }).click();
  await expect(page.getByText("Text confirmed locally.")).toBeVisible();

  const runRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/runs",
  );
  await page.getByRole("button", { name: "Build demo action plan" }).click();
  const runRequest = await runRequestPromise;
  const runPayload = runRequest.postDataJSON() as Record<string, unknown>;

  expect(runPayload).toEqual({
    schema_version: "1.0",
    source_text: finalText,
    locale: "en-US",
    timezone: "Europe/Copenhagen",
    reference_date: "2026-01-15",
  });
  expect(JSON.stringify(runPayload)).not.toMatch(/image|base64|data:image/i);
  await page.getByLabel("Your answer").fill("2026-01-22");
  await page.getByRole("button", { name: "Resume this run" }).click();
  await expect(
    page.getByRole("heading", { name: "Decide each candidate separately." }),
  ).toBeVisible();
  expect([...unexpectedOrigins]).toEqual([]);
});
