// An email address as a production log line names a customer (James,
// #496): enough to check the right account was touched, without the
// address itself. The part before the @ and the domain are masked
// apart, each keeping its first three and last three characters with
// an asterisk for every one between; a part of six or fewer is all
// asterisks. abcdefgh@example.com becomes abc**fgh@exa*****com.
//
// A log line carries one in a field not named for personal data
// (`record`, not `email`), which log.mjs's scrubber would remove.

const KEEP = 3;

const maskPart = (part) => (part.length <= KEEP * 2
  ? "*".repeat(part.length)
  : part.slice(0, KEEP) + "*".repeat(part.length - KEEP * 2)
    + part.slice(-KEEP));

export const maskEmail = (email) => {
  const address = String(email || "").trim().toLowerCase();
  const at = address.lastIndexOf("@");

  if (at < 0) return maskPart(address);

  return `${maskPart(address.slice(0, at))}@${
    maskPart(address.slice(at + 1))}`;
};

// `text` with `email` masked wherever it appears, as typed or as a URL
// carries it (abc%40example.com, which the scrubber's pattern misses):
// for a service's error message, which names the address it was
// asked about.
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const maskIn = (text, email) => {
  const address = String(email || "").trim().toLowerCase();

  if (!address) return String(text);

  const forms = [address, encodeURIComponent(address)].map(literal);

  return String(text).replace(new RegExp(forms.join("|"), "gi"),
    maskEmail(address));
};
