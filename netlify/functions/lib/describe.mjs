// The words that say when and how an order is fulfilled, shared by
// the emails and the account pages so the customer reads the same
// words everywhere.

// "10:00 AM – 4:00 PM" -> "10 AM and 4 PM", for "between ... and ...".
export const between = (window) =>
  window.replace(/:00/g, "").split(/\s*–\s*/).join(" and ");

export const methodName = (method) => ({
  delivery: "Delivery",
  scituate: "Scituate drop site",
  onfarm: "On-farm pickup",
}[method] || method);
