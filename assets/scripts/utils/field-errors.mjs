// The words for a field that is empty or wrong, one source for the
// browser's checks and the server's answers (Q21b). An empty field
// asks for it ("Please enter an email address."); one filled in wrong
// asks for a valid one ("Please enter a valid email address."). Names
// are as the label shows them, lower case mid-sentence.

const NAMES = {
  email: "email address",
  phone: "phone number",
  zip: "ZIP code",
  card: "card number",
  expiration: "expiration date",
};

export const enterField = (field) => {
  const name = NAMES[field];

  return `Please enter ${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}.`;
};

export const validField = (field) => `Please enter a valid ${NAMES[field]}.`;

// The message for `value` in `field`: the empty one when there is
// nothing, the valid one otherwise.
export const fieldError = (field, value) => String(value ?? "").trim()
  ? validField(field) : enterField(field);
