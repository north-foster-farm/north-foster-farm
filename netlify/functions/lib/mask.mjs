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
