// The library's one record (docs/refactors/staging-library.md, phase
// 3): the emails, the sent mail, the open email, its view, the
// approval filter and whether the editor is open. Each function gives
// a new record and leaves the one it is given as it was.

export const initial = () => ({
  emails: null, sent: [], current: null, view: "html", approval: "",
  editing: false,
});

// The email with that id open, or none; a rewritten one opens at its
// rewrite.
export const opened = (state, id) => {
  const current = state.emails.find((e) => e.id === id) || null;
  const mine = current && current.approval === "rewritten";

  return { ...state, current, view: mine ? "rewrite" : state.view };
};

// A review saved: the server's answer replaces the email in the list,
// and as the open one when it is open.
export const saved = (state, email) => ({
  ...state,
  emails: state.emails.map((e) => (e.id === email.id ? email : e)),
  current: state.current && state.current.id === email.id
    ? email : state.current,
});
