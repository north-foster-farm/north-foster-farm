// Stricter than type="email", which lets "you@farm" through.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const looksLikeEmail = (value) => EMAIL.test(String(value).trim());
