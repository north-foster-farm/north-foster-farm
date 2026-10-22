// Ends a sentence that may end on a product's name. Some names end in
// a period of their own ("Feet, 1 lb avg."), and a second one read as
// a typo: "Not available: Feet, 1 lb avg.." (#159).
export const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
