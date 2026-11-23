// `bin/nff e2e` records its run for James's status line (#647).
//
// On James's Mac, ~/.bin/report_run runs a build, a test or an e2e run
// and records how it went: `report_run e2e -- COMMAND...`. npm also
// runs every script through it (`script-shell` in ~/.npmrc), so a
// script named e2e or test:e2e is recorded already. bin/nff e2e hands
// itself to report_run when the script is there and executable, and
// nobody records it yet; the second bin/nff, under report_run, does the
// work. Where there is no report_run (CI, cloud runs), nothing changes.
//
// The handoff happens before bin/nff prints anything, so the output,
// the verdict and the exit status are the child's, untouched. A dry run
// and help dispatch nothing and are not recorded.

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Set on the child, so it runs the command instead of handing off again.
export const UNDER = "NFF_E2E_REPORTED";

// The npm scripts report_run records as an e2e run, by
// npm_lifecycle_event.
const NPM_E2E = ["e2e", "test:e2e"];

const on = (value) => value !== "false";

// Whether `argv` (bin/nff's, from the group on) is a run that records:
// `e2e`, without --dry-run, --help or -h.
export const records = (argv) => {
  if (argv[0] !== "e2e") return false;

  return !argv.slice(1).some((arg) => {
    if (arg === "-h") return true;
    const m = arg.match(/^--(dry-run|help)(?:=(.*))?$/);

    return !!m && (m[2] === undefined || on(m[2]));
  });
};

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const same = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

// Whether report_run already records this run as e2e: bin/nff's own
// child, or an npm script named e2e or test:e2e run through it.
export const underReportRun = (env, script) => env[UNDER] === "1"
  || (NPM_E2E.includes(env.npm_lifecycle_event || "")
    && !!env.npm_config_script_shell
    && same(env.npm_config_script_shell, script));

// The report_run to hand this run to, or null to run it here. The home
// folder is homedir()'s, which follows HOME on macOS and Linux.
export const reportRunFor = (argv, env, deps = {}) => {
  const { isExecutable = executable, home = homedir() } = deps;

  if (!home || !records(argv)) return null;
  const script = join(home, ".bin", "report_run");

  if (!isExecutable(script) || underReportRun(env, script)) return null;

  return script;
};

// Runs `node bin/nff ARGV...` under report_run and returns the exit
// status to end with: the child's, or 1 when a signal ended it. Null
// when report_run would not start, so the caller runs the command
// itself, unrecorded, rather than fail over the status line.
/**
 * @public bin/nff imports it; Knip reads no file without an extension.
 */
export const handOff = (script, nff, argv, env) => {
  const done = spawnSync(script,
    ["e2e", "--", process.execPath, nff, ...argv],
    { stdio: "inherit", env: { ...env, [UNDER]: "1" } });

  if (done.error) return null;

  return done.status === null ? 1 : done.status;
};
