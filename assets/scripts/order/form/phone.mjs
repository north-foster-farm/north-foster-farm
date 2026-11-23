// The phone field's mask (docs/refactors/order-form.md, phase 2).
// Pure: contact.js writes what it returns into the field.

// The number as "(xxx) xxx-xxxx" while it is typed. `raw` is the
// field's value, `deleting` that the input was a deletion: one that
// lands on a bracket, a space or a dash takes the digit before it too,
// so backspace never fights the mask. A leading 1 is dropped, and
// digits past the tenth.
export const maskPhone = (raw, deleting) => {
  let digits = raw.replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (deleting && /\D$/.test(raw)) digits = digits.slice(0, -1);
  digits = digits.slice(0, 10);

  if (digits.length <= 3) return digits ? `(${digits}` : "";
  if (digits.length <= 6) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};
