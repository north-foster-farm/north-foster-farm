// #294: the toolbar's clock. A tester moves the site's "now" for their
// own browser on staging; it reaches the server; it cannot be turned on
// in production or on a preview; and what must keep real time does.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import dates from "../netlify/functions/dates.mjs";
import {
  CLOCK_COOKIE, MAX_OFFSET, clockAllowed, now, offsetFrom, real, runAs,
  within,
} from "../netlify/functions/lib/clock.mjs";
import { COOKIE } from "../netlify/functions/lib/gate.mjs";
import { testStores as plainStores } from "../netlify/functions/lib/store.mjs";
import { handle } from "../netlify/functions/staging.mjs";

const DAY = 24 * 60 * 60_000;
const ID = "tester-session-id-0123456789abcdef";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const staging = {
  SITE_CONTEXT: "branch-deploy", STAGING_TOKEN: "s3cret",
  GATE_TOOLBAR_EMAIL: "james@example.com",
};

const withCookie = (offset, path = "/api/dates", extra = "") =>
  new Request(`https://x${path}`, {
    headers: { Cookie: `${CLOCK_COOKIE}=${offset}${extra}` },
  });

const near = (a, b, ms = 5000) => Math.abs(a - b) < ms;

describe("where the clock may move", () => {
  it("staging and a local run only", () => {
    assert.equal(clockAllowed({ SITE_CONTEXT: "branch-deploy" }), true);
    assert.equal(clockAllowed({ CONTEXT: "dev" }), true);
    for (const env of [{}, { SITE_CONTEXT: "production" },
      { CONTEXT: "production" }, { SITE_CONTEXT: "deploy-preview" },
      { SITE_CONTEXT: "production", CONTEXT: "branch-deploy" }]) {
      assert.equal(clockAllowed(env), false, JSON.stringify(env));
    }
  });

  it("ignores the cookie in production, unset and on a preview", () => {
    const headers = withCookie(DAY).headers;

    assert.equal(offsetFrom(headers, { SITE_CONTEXT: "branch-deploy" }), DAY);
    for (const env of [{}, { SITE_CONTEXT: "production" },
      { SITE_CONTEXT: "deploy-preview" }]) {
      assert.equal(offsetFrom(headers, env), 0, JSON.stringify(env));
    }
  });

  it("refuses an offset that is not a number or too far", () => {
    const env = { SITE_CONTEXT: "branch-deploy" };

    for (const raw of ["abc", "1e9", "12.5", "", `${MAX_OFFSET + 1}`,
      `-${MAX_OFFSET + 1}`, "99999999999999"]) {
      assert.equal(offsetFrom(withCookie(raw).headers, env), 0, raw);
    }
    assert.equal(offsetFrom(withCookie(-DAY).headers, env), -DAY);
  });
});

describe("the business clock", () => {
  it("is the real time outside any request", () => {
    assert.ok(near(now().getTime(), Date.now(), 50));
  });

  it("moves inside a request that asks, and real() undoes it", async () => {
    await within(withCookie(3 * DAY), async () => {
      assert.ok(near(now().getTime(), Date.now() + 3 * DAY));

      // Work left running after the answer keeps the request's clock.
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(near(now().getTime(), Date.now() + 3 * DAY));

      const t = now();

      assert.ok(near(real(t).getTime(), Date.now()));
    }, { SITE_CONTEXT: "branch-deploy" });
  });

  it("belongs to one request: another's is untouched", async () => {
    const env = { SITE_CONTEXT: "branch-deploy" };
    const [a, b] = await Promise.all([
      within(withCookie(DAY), async () => {
        await new Promise((r) => setTimeout(r, 5));

        return now().getTime() - Date.now();
      }, env),
      within(new Request("https://x/"), async () => {
        await new Promise((r) => setTimeout(r, 1));

        return now().getTime() - Date.now();
      }, env),
    ]);

    assert.ok(near(a, DAY));
    assert.ok(near(b, 0));
  });
});

describe("the clock reaches a function", () => {
  const ask = async (env) => {
    const saved = { ...process.env };

    Object.assign(process.env, env);
    try {
      const res = await dates(withCookie(10 * DAY));

      return Date.parse((await res.json()).now);
    } finally {
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("/api/dates answers on the tester's clock on staging", async () => {
    assert.ok(near(await ask({ SITE_CONTEXT: "branch-deploy" }),
      Date.now() + 10 * DAY));
  });

  it("is impossible in production: the same request gets real time",
    async () => {
      assert.ok(near(await ask({ SITE_CONTEXT: "production" }), Date.now()));
      assert.ok(near(await ask({ SITE_CONTEXT: "deploy-preview" }),
        Date.now()));
    });
});

describe("the toolbar's clock endpoint", () => {
  const stores = () => {
    const s = plainStores();

    s.gate.data.set("allow/pat@example.com", { addedAt: "2026-10-18" });
    s.gate.data.set(`session/${hash(ID)}`, {
      email: "pat@example.com", createdAt: "2026-10-18",
      expires: Date.now() + DAY,
    });

    return s;
  };
  const req = (method, body, cookie = "") =>
    new Request("https://x/api/staging/clock", {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: `${COOKIE}=${ID}${cookie}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("sets, reads and resets this browser's clock", async () => {
    const at = new Date(Date.now() + 40 * DAY);
    const set = await handle(req("PUT", { at: at.toISOString() }),
      { stores: stores(), env: staging });
    const cookie = set.headers.get("set-cookie");
    const offset = Number(cookie.match(/nff_clock=(-?\d+)/)[1]);

    assert.equal(set.status, 200);
    assert.ok(near(offset, 40 * DAY));
    assert.match(cookie, /Path=\/; Secure; SameSite=Lax$/);

    const read = await (await handle(req("GET", null,
      `; ${CLOCK_COOKIE}=${offset}`), { stores: stores(), env: staging }))
      .json();

    assert.equal(read.offset, offset);
    assert.ok(near(Date.parse(read.now), at.getTime()));

    const reset = await handle(req("DELETE"),
      { stores: stores(), env: staging });

    assert.match(reset.headers.get("set-cookie"), /nff_clock=; .*Max-Age=0/);
  });

  it("refuses nonsense and anything past three years", async () => {
    for (const at of ["soon", Date.now() + 4 * 366 * DAY]) {
      const res = await handle(req("PUT", { at: new Date(at).toString() }),
        { stores: stores(), env: staging });

      assert.equal(res.status, 400, String(at));
    }
  });

  it("is a 404 in production and on a preview", async () => {
    for (const env of [{ ...staging, SITE_CONTEXT: "production" },
      { ...staging, SITE_CONTEXT: "deploy-preview" }]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const body = method === "PUT"
          ? { at: new Date().toISOString() } : null;
        const res = await handle(req(method, body), { stores: stores(), env });

        assert.equal(res.status, 404, `${env.SITE_CONTEXT} ${method}`);
        assert.equal(res.headers.get("set-cookie"), null);
      }
    }
  });

  it("never revives a gate session that has ended", async () => {
    const s = stores();

    s.gate.data.set(`session/${hash(ID)}`, {
      email: "pat@example.com", createdAt: "2026-10-18",
      expires: Date.now() - 1000,
    });

    const res = await runAs({ offset: -2 * DAY },
      () => handle(req("GET"), { stores: s, env: staging }));

    assert.equal(res.status, 401);
  });

  it("runs the jobs at a time of day on the tester's day", async () => {
    const runs = [];
    const run = async (s, opts) => {
      runs.push(opts.now.toISOString());

      return {};
    };
    // 2026-12-31 15:00 New York, as the tester's clock reads.
    const offset = Date.parse("2026-12-31T20:00:00Z") - Date.now();

    await runAs({ offset }, () => handle(new Request(
      "https://x/api/staging/jobs/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Cookie: `${COOKIE}=${ID}`,
        },
        body: JSON.stringify({ time: "06:00" }),
      }), { stores: stores(), env: staging, run }));

    assert.deepEqual(runs, ["2026-12-31T11:00:00.000Z"]);
  });
});
