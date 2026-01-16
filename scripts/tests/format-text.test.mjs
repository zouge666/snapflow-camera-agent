import assert from "node:assert/strict";
import test from "node:test";

import { formatText } from "../lib/format-text.mjs";

test("normalizes line endings and trailing whitespace", () => {
  assert.equal(formatText("one  \r\ntwo\t\r\n\r\n"), "one\ntwo\n");
});

test("preserves Markdown hard breaks when requested", () => {
  assert.equal(
    formatText("one  \r\ntwo", { preserveTrailingWhitespace: true }),
    "one  \ntwo\n",
  );
});
