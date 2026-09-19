// The farm's name, address, phone and email, from the same data file
// Hugo reads for the templates. Imported as JSON so the bundler
// carries it into the function; a runtime file read broke on Netlify,
// where the bundle's path depth differs from the repo's.

import company from "../../../data/company.json" with { type: "json" };

export { company };
