// The run's global teardown: adds up the workers' function calls into
// test-results/function-calls.json and prints one line (#519,
// e2e/support/calls.mjs). It runs whatever reporter the command line
// chose, and it never fails the run: a count is not a test.

import { writeReport } from "./calls.mjs";

export default async () => {
  try {
    console.log(writeReport());
  } catch (error) {
    console.log(`Function calls: not counted (${error.message}).`);
  }
};
