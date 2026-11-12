// A shipped log line holds the fixed top-level fields and one map
// field, whatever the call site logs (#571): the store makes a field
// of every key path, and the free plan stops at 256 per dataset.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FIXED, MAP, flush, log, scrub,
} from "../netlify/functions/lib/log.mjs";
import { shipLog } from "../bin/ship-log.mjs";

const AXIOM = { AXIOM_TOKEN: "t", AXIOM_DATASET: "d", DEPLOY_ID: "dep" };

const axiom = () => {
  const bodies = [];

  return {
    bodies,
    fetchImpl: async (url, init) => {
      bodies.push(init.body);

      return { ok: true, status: 200 };
    },
  };
};

// A small seeded generator, so a failure repeats.
const random = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;

  return seed / 2147483648;
};

const KEYS = [
  ...FIXED, MAP, "source", "deploy", "order", "email", "customer",
  "items", "a.b", "weird key", "stack", "nested", "x", "orderId",
];

// A record of any shape: deep objects, arrays, errors, the fixed keys
// holding objects, personal fields, an address in free text.
const record = (next, depth = 0) => {
  const out = {};
  const count = 1 + Math.floor(next() * 6);

  for (let i = 0; i < count; i += 1) {
    const key = KEYS[Math.floor(next() * KEYS.length)];
    // Leaves only, past ten levels.
    const pick = depth < 10 ? next() : 0.4 + next() * 0.6;

    out[key] = pick < 0.3 ? record(next, depth + 1)
      : pick < 0.4 ? [record(next, depth + 1), 3, "pat@example.com"]
        : pick < 0.5 ? new Error(`boom ${i}`)
          : pick < 0.6 ? `write to pat${i}@example.com or 802 555 0142`
            : pick < 0.7 ? null
              : pick < 0.8 ? i
                : pick < 0.9 ? true : `value ${i}`;
  }

  return out;
};

const plain = (v) => v === null || ["string", "number", "boolean"]
  .includes(typeof v);

const quiet = (t) => {
  for (const name of ["info", "warn", "error"]) {
    t.mock.method(console, name, () => {});
  }
};

describe("a shipped log line", () => {
  it("has only the fixed fields and the map field, at any depth",
    async (t) => {
      quiet(t);
      await flush({ env: {} });

      const next = random(571);
      const logged = [];

      for (let i = 0; i < 200; i += 1) {
        const level = ["info", "warn", "error"][i % 3];

        logged.push(log[level](i % 17 === 0 ? `plain ${i}` : record(next)));
      }

      const { bodies, fetchImpl } = axiom();

      assert.equal(await flush({ env: AXIOM, fetchImpl }), 200);

      const shipped = JSON.parse(bodies[0]);
      const allowed = new Set([...FIXED, MAP]);

      assert.equal(shipped.length, 200);
      shipped.forEach((line, i) => {
        for (const [key, value] of Object.entries(line)) {
          assert.ok(allowed.has(key), `line ${i}: ${key} is not fixed`);
          if (key !== MAP) assert.ok(plain(value), `line ${i}: ${key}`);
        }
        assert.equal(typeof line[MAP], "object");
        assert.equal(line.source, "site");
        assert.equal(line.deploy, "dep");

        // The split moves values and changes none: the scrubbed line,
        // as the console wrote it, comes back from the two halves.
        const drop = (o) => Object.fromEntries(Object.entries(o)
          .filter(([key]) => key !== "source" && key !== "deploy"));
        const { [MAP]: data, ...top } = line;

        assert.deepEqual(drop({ ...data, ...top }), drop(logged[i]));
      });

      // The scrub ran first: no address or phone number made it.
      assert.doesNotMatch(bodies[0], /example\.com/);
      assert.doesNotMatch(bodies[0], /555 0142/);
    });

  it("keeps a personal field removed inside the map", async (t) => {
    quiet(t);
    await flush({ env: {} });
    log.info({
      event: "test.deep", id: "A-1",
      order: { customer: { email: "pat@example.com" }, total: 12 },
    });

    const { bodies, fetchImpl } = axiom();

    await flush({ env: AXIOM, fetchImpl });

    const [line] = JSON.parse(bodies[0]);

    assert.equal(line.event, "test.deep");
    assert.equal(line.id, "A-1");
    assert.deepEqual(line.data, {
      order: { customer: "[removed]", total: 12 },
    });
    assert.deepEqual(scrub({ customer: { email: "x" } }),
      { customer: "[removed]" });
  });

  it("from bin/nff, has the same shape", async (t) => {
    quiet(t);
    await flush({ env: {} });
    log.info({ event: "test.cli", by: "james", before: { a: { b: 1 } } });

    const { bodies, fetchImpl } = axiom();

    assert.equal(await shipLog({ env: AXIOM, fetchImpl }), 1);

    const [line] = JSON.parse(bodies[0]);

    assert.deepEqual(Object.keys(line).sort(),
      ["_time", "data", "deploy", "event", "level", "source"]);
    assert.equal(line.source, "cli");
    assert.deepEqual(line.data, { by: "james", before: { a: { b: 1 } } });
  });
});

describe("docs/monitoring.md", () => {
  const doc = readFileSync(new URL("../docs/monitoring.md", import.meta.url),
    "utf8");

  it("names each environment's dataset, from the samples", () => {
    const security = readFileSync(new URL("../docs/security.md",
      import.meta.url), "utf8");

    for (const env of ["production", "staging"]) {
      const sample = readFileSync(new URL(`../.env.${env}.sample`,
        import.meta.url), "utf8");
      const [, dataset] = sample.match(/^AXIOM_DATASET=(\S+)$/m);

      assert.ok(doc.includes(`\`${dataset}\``), `${env}: ${dataset}`);
      assert.ok(doc.includes(`['${dataset}']`), `APL: ${dataset}`);
      assert.ok(security.includes(`\`${dataset}\``),
        `security.md, ${env}: ${dataset}`);
    }
  });

  it("describes the map field and its fixed fields", () => {
    assert.match(doc, /map field/);
    assert.ok(doc.includes(`\`${MAP}\``));
    for (const key of FIXED) assert.ok(doc.includes(`\`${key}\``), key);
  });
});
