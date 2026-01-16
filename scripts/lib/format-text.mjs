export function formatText(source, { preserveTrailingWhitespace = false } = {}) {
  let formatted = source.replace(/\r\n?/g, "\n");

  if (!preserveTrailingWhitespace) {
    formatted = formatted.replace(/[\t ]+$/gm, "");
  }

  return `${formatted.replace(/\n*$/, "")}\n`;
}
