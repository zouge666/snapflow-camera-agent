import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("sample review reaches a partial approved-only ICS download without a key", async ({
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

  const planRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/demo/action-plan",
  );
  await page.getByRole("button", { name: "Build demo action plan" }).click();
  const planRequest = await planRequestPromise;
  const planPayload = planRequest.postDataJSON() as Record<string, unknown>;

  expect(planPayload).toMatchObject({
    locale: "en-US",
    timezone: "Europe/Copenhagen",
    reference_date: "2026-07-16",
  });
  expect(JSON.stringify(planPayload)).not.toMatch(/image|base64|data:image/i);

  await expect(
    page.getByRole("heading", { name: "Decide each candidate separately." }),
  ).toBeVisible();
  const reviews = page.getByRole("list", { name: "Candidate action reviews" });
  await expect(reviews.getByRole("listitem")).toHaveCount(3);

  const downloadButton = page.getByRole("button", {
    name: "Download approved .ics",
  });
  await expect(downloadButton).toBeDisabled();

  const checklist = reviews
    .getByRole("listitem")
    .filter({ hasText: "Send the revised onboarding checklist" });
  const supportFaq = reviews
    .getByRole("listitem")
    .filter({ hasText: "Prepare the support FAQ" });

  await checklist.getByRole("button", { name: "Approve" }).click();
  await supportFaq.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("1 approved", { exact: true })).toBeVisible();
  await expect(page.getByText("1 rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(downloadButton).toBeEnabled();

  const exportRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/demo/exports/ics",
  );
  const downloadPromise = page.waitForEvent("download");
  await downloadButton.click();
  const [exportRequest, download] = await Promise.all([
    exportRequestPromise,
    downloadPromise,
  ]);
  const exportPayload = exportRequest.postDataJSON() as {
    approved_items: readonly Record<string, unknown>[];
  };

  expect(exportPayload.approved_items).toHaveLength(1);
  expect(exportPayload.approved_items[0]).toMatchObject({
    id: "action-1",
    decision: "approved",
    due_date: "2026-07-17",
  });
  expect(JSON.stringify(exportPayload)).not.toMatch(/action-2|action-3/);

  expect(download.suggestedFilename()).toBe("snapflow-approved-actions.ics");
  const downloadPath = await download.path();
  if (downloadPath === null) {
    throw new Error("Playwright did not persist the downloaded calendar.");
  }
  const calendar = await readFile(downloadPath, "utf8");

  expect(calendar).toContain("BEGIN:VCALENDAR\r\n");
  expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(calendar).toContain("SUMMARY:Send the revised onboarding checklist\r\n");
  expect(calendar).toContain("DTSTART;VALUE=DATE:20260717\r\n");
  expect(calendar).not.toMatch(/support FAQ|pilot review/i);
  await expect(page.getByText("1 calendar event downloaded.")).toBeVisible();
  expect([...unexpectedOrigins]).toEqual([]);
});
