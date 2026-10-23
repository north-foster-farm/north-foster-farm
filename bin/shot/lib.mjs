// Upload screenshots for GitHub issues and comments. GitHub has no API
// for the attachments its web editor takes, so the images go on a
// `screenshots` branch that shares no history with main, and the
// markdown links to them there. The branch never merges or deploys.
//
// Everything goes through `gh api`, so it runs as whoever `gh` is
// logged in as, or as GH_TOKEN when that is set.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";

export const BRANCH = "screenshots";

// GitHub renders up to 10 MB per image in issues.
export const MAX_BYTES = 10 * 1024 * 1024;

export const TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const README = `# Screenshots

Images that agents post in issues, pull requests and comments: mockups,
and screenshots of development and staging. This branch shares no
history with \`main\` and is never merged or deployed. Upload with
\`bin/gh-shot\`.

Everything here is public and stays in git history. Never add an image
that shows customer data or anything from production.
`;

export const USAGE = `Usage:
  bin/gh-shot [--issue N] [--alt text] [--repo owner/name] FILE...

Uploads each image to the repo's "${BRANCH}" branch and prints a
markdown line for it, ready for gh issue comment --body or a body file.

  --issue N   file the images under issue-N/ (otherwise misc/)
  --alt text  alt text for every image (default: the file's name)
  --repo      owner/name (default: the repo of the current folder)

Public: only mockups and development or staging screens, never
customer data or production.`;

export function parseArgs(argv) {
  const opts = { files: [], issue: null, alt: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (["--issue", "--alt", "--repo"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      opts[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.issue !== null && !/^[1-9]\d*$/.test(opts.issue)) {
    throw new Error(`--issue takes a number, not "${opts.issue}"`);
  }
  if (opts.repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    throw new Error(`--repo takes owner/name, not "${opts.repo}"`);
  }
  return opts;
}

// Refuse what GitHub won't render inline, before anything is uploaded.
export function checkImage(file, bytes) {
  const ext = extname(file).toLowerCase();
  if (!TYPES.has(ext)) {
    throw new Error(`${file}: not a png, jpg, gif or webp image`);
  }
  if (bytes > MAX_BYTES) {
    throw new Error(`${file}: over 10 MB; GitHub won't render it`);
  }
}

// Where an image goes on the branch: grouped by issue and day, with
// the time and a random tag so two uploads never collide.
export function shotPath(file, { issue = null, now = new Date(),
  tag = randomBytes(3).toString("hex") } = {}) {
  const ext = extname(file).toLowerCase();
  const slug = basename(file, extname(file)).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shot";
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  const folder = issue === null ? "misc" : `issue-${issue}`;
  return `${folder}/${day}/${time}-${tag}-${slug}${ext}`;
}

// A blob link with ?raw=true renders in issues whether the repo is
// public or private; a raw.githubusercontent.com link breaks once the
// repo goes private.
export function shotUrl(repo, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${BRANCH}/${encoded}?raw=true`;
}

export function markdown(alt, url) {
  const text = alt.replace(/[[\]\\]/g, "");
  return `![${text}](${url})`;
}

export function gh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not run gh: ${result.error.message}`);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function api(path, { method = "GET", body } = {}) {
  const args = ["api", "-X", method, path];
  if (body !== undefined) {
    args.push("--input", "-");
  }
  const result = gh(args, body);
  if (!result.ok) {
    throw new Error(`gh api ${method} ${path}: ${result.stderr}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

export function currentRepo() {
  const result = gh(["repo", "view", "--json", "nameWithOwner",
    "-q", ".nameWithOwner"]);
  if (!result.ok) {
    throw new Error(`Can't tell the repo; pass --repo. ${result.stderr}`);
  }
  return result.stdout;
}

// Make the branch on first use: a root commit with only the README.
export function ensureBranch(repo) {
  const found = gh(["api", `repos/${repo}/branches/${BRANCH}`]);
  if (found.ok) {
    return false;
  }
  if (!found.stderr.includes("404")) {
    throw new Error(`Can't read the ${BRANCH} branch: ${found.stderr}`);
  }
  const blob = api(`repos/${repo}/git/blobs`, {
    method: "POST",
    body: { content: README, encoding: "utf-8" },
  });
  const tree = api(`repos/${repo}/git/trees`, {
    method: "POST",
    body: { tree: [{
      path: "README.md", mode: "100644", type: "blob", sha: blob.sha,
    }] },
  });
  const commit = api(`repos/${repo}/git/commits`, {
    method: "POST",
    body: {
      message: "Start the screenshots branch",
      tree: tree.sha,
      parents: [],
    },
  });
  api(`repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha },
  });
  return true;
}

export function upload(repo, path, data) {
  api(`repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: {
      message: `Add ${path}`,
      content: data.toString("base64"),
      branch: BRANCH,
    },
  });
  return shotUrl(repo, path);
}
