// Upload screenshots for GitHub issues and comments. GitHub has no API
// for the attachments its web editor takes, so the images go on a
// `screenshots` branch that shares no history with main, and the
// markdown links to them there. The branch never merges or deploys.
//
// Everything goes through `gh api`, so it runs as whoever `gh` is
// logged in as, or as GH_TOKEN when that is set.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

export const BRANCH = "screenshots";

// GitHub renders up to 10 MB per image in issues.
export const MAX_BYTES = 10 * 1024 * 1024;

export const TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

// Repos that take uploads without --any-repo (lowercase).
export const REPOS = new Set([
  "north-foster-farm/north-foster-farm",
  "north-foster-farm/nff-dashboard",
]);

const README = `# Screenshots

Images that agents post in issues, pull requests and comments: mockups,
and screenshots of development and staging. This branch shares no
history with \`main\` and is never merged or deployed. Upload with
\`bin/gh-shot\`.

Everything here is public and stays in git history. Never add an image
that shows customer data or anything from production.
`;

export const USAGE = `Usage:
  bin/gh-shot [--issue N] [--alt text] [--repo owner/name]
              [--any-repo] FILE...

Uploads each image to the repo's "${BRANCH}" branch and prints a
markdown line for it, ready for gh issue comment --body or a body file.

  --issue N   file the images under issue-N/ (otherwise misc/)
  --alt text  alt text for every image (default: the file's name)
  --repo      owner/name (default: the repo of the current folder)
  --any-repo  allow a repo other than the farm's own two

Public: only mockups and development or staging screens, never
customer data or production.`;

export function parseArgs(argv) {
  const opts = {
    files: [], issue: null, alt: null, repo: null, anyRepo: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--any-repo") {
      opts.anyRepo = true;
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
  if (opts.repo !== null && !validRepo(opts.repo)) {
    throw new Error(`--repo takes owner/name, not "${opts.repo}"`);
  }
  return opts;
}

function validRepo(repo) {
  const parts = repo.split("/");
  return /^[\w.-]+\/[\w.-]+$/.test(repo)
    && !parts.some((part) => part === "." || part === "..");
}

// The uploads are public and permanent, so only the farm's own repos
// are fair game unless the caller says otherwise.
export function checkRepo(repo, anyRepo = false) {
  if (!validRepo(repo)) {
    throw new Error(`Repo must be owner/name, not "${repo}"`);
  }
  if (!anyRepo && !REPOS.has(repo.toLowerCase())) {
    throw new Error(`${repo}: not a North Foster Farm repo; `
      + "pass --any-repo to upload there anyway");
  }
}

const SIGNATURES = {
  ".png": [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  ".jpg": [[0, [0xff, 0xd8, 0xff]]],
  ".gif": [[0, [..."GIF87a"].map(code)], [0, [..."GIF89a"].map(code)]],
  ".webp": [[0, [..."RIFF"].map(code)], [8, [..."WEBP"].map(code)]],
};
SIGNATURES[".jpeg"] = SIGNATURES[".jpg"];

function code(char) {
  return char.charCodeAt(0);
}

function matches(data, [offset, bytes]) {
  return bytes.every((byte, i) => data[offset + i] === byte);
}

// GIF accepts either signature; WEBP needs both parts.
function hasSignature(ext, data) {
  const sigs = SIGNATURES[ext];
  return ext === ".gif"
    ? sigs.some((sig) => matches(data, sig))
    : sigs.every((sig) => matches(data, sig));
}

// Refuse what GitHub won't render inline, before anything is uploaded.
// The extension is not trusted: the content must carry the matching
// magic bytes, so a renamed secret never gets published.
export function checkImage(file, data) {
  const ext = extname(file).toLowerCase();
  if (!TYPES.has(ext)) {
    throw new Error(`${file}: not a png, jpg, gif or webp image`);
  }
  if (data.length > MAX_BYTES) {
    throw new Error(`${file}: over 10 MB; GitHub won't render it`);
  }
  if (!hasSignature(ext, data)) {
    throw new Error(`${file}: content is not a real ${ext.slice(1)} `
      + "image; refusing to upload");
  }
}

// Read an image for upload. Symlinks are refused so a link can't point
// the upload at some other file.
export function readImage(file) {
  if (lstatSync(file).isSymbolicLink()) {
    throw new Error(`${file}: is a symlink; refusing to upload`);
  }
  const data = readFileSync(file);
  checkImage(file, data);
  return data;
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

function api(path, { method = "GET", body } = {}, run = gh) {
  const args = ["api", "-X", method, path];
  if (body !== undefined) {
    args.push("--input", "-");
  }
  const result = run(args, body);
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
// Parallel first uploads race to make it; the loser's ref POST gets a
// 422 (already exists), so it re-reads the branch and carries on.
export function ensureBranch(repo, run = gh) {
  const found = run(["api", `repos/${repo}/branches/${BRANCH}`]);
  if (found.ok) {
    return false;
  }
  if (!found.stderr.includes("404")) {
    throw new Error(`Can't read the ${BRANCH} branch: ${found.stderr}`);
  }
  const blob = api(`repos/${repo}/git/blobs`, {
    method: "POST",
    body: { content: README, encoding: "utf-8" },
  }, run);
  const tree = api(`repos/${repo}/git/trees`, {
    method: "POST",
    body: { tree: [{
      path: "README.md", mode: "100644", type: "blob", sha: blob.sha,
    }] },
  }, run);
  const commit = api(`repos/${repo}/git/commits`, {
    method: "POST",
    body: {
      message: "Start the screenshots branch",
      tree: tree.sha,
      parents: [],
    },
  }, run);
  const ref = run(["api", "-X", "POST", `repos/${repo}/git/refs`,
    "--input", "-"], { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  if (ref.ok) {
    return true;
  }
  if (!ref.stderr.includes("422")) {
    throw new Error(`Can't make the ${BRANCH} branch: ${ref.stderr}`);
  }
  // Someone else made it first; make sure it is really there.
  api(`repos/${repo}/branches/${BRANCH}`, {}, run);
  return false;
}

export const UPLOAD_RETRIES = 2;

// A 409 means the branch moved under a parallel upload; re-read it
// and try again, up to UPLOAD_RETRIES more times.
export function upload(repo, path, data, run = gh) {
  const args = ["api", "-X", "PUT", `repos/${repo}/contents/${path}`,
    "--input", "-"];
  const body = {
    message: `Add ${path}`,
    content: data.toString("base64"),
    branch: BRANCH,
  };
  for (let attempt = 0; ; attempt++) {
    const result = run(args, body);
    if (result.ok) {
      return shotUrl(repo, path);
    }
    if (!result.stderr.includes("409") || attempt >= UPLOAD_RETRIES) {
      throw new Error(`gh api PUT ${path}: ${result.stderr}`);
    }
    api(`repos/${repo}/branches/${BRANCH}`, {}, run);
  }
}
