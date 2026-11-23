// Apart from dispatch.mjs, so the scripts dispatch imports can use it
// without an import cycle (#782 step 8, no-circular).

// Text from a log or the API with every C0 and C1 control character
// gone, colors and other escape sequences first, so none reaches the
// terminal. Bidi overrides and isolates go too, so none reorders a
// line.
/* eslint-disable no-control-regex -- control characters are the point */
export const printable = (text) => String(text)
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
  .replace(/\t/g, " ")
  .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, "");
/* eslint-enable no-control-regex */
