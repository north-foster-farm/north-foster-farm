import { timingSafeEqual } from "node:crypto";

// Compares in constant time, so the answer's timing says nothing about
// how much of a guess was right.
export const sameToken = (given, expected) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));

  return a.length === b.length && timingSafeEqual(a, b);
};
