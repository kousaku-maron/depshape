import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Source =
  | { kind: "worktree" }
  | { kind: "index" }
  | { kind: "rev"; rev: string };

export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout;
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveRev(root: string, rev: string): Promise<string> {
  try {
    return (await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim();
  } catch {
    throw new Error(`リビジョン '${rev}' が見つかりません`);
  }
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  return (await git(root, ["merge-base", a, b])).trim();
}

export async function listFiles(root: string, source: Source): Promise<string[]> {
  let out: string;
  switch (source.kind) {
    case "rev":
      out = await git(root, ["ls-tree", "-r", "-z", "--name-only", source.rev]);
      break;
    case "index":
      out = await git(root, ["ls-files", "-z", "--cached"]);
      break;
    case "worktree":
      // tracked + untracked (respecting .gitignore); deleted files are filtered when reading
      out = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      break;
  }
  return [...new Set(out.split("\0").filter(Boolean))];
}

/**
 * Reads file contents for the given source. Missing files (e.g. deleted in the
 * working tree but still in the index) are omitted from the result.
 */
export async function readFiles(
  root: string,
  source: Source,
  paths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  if (source.kind === "worktree") {
    await Promise.all(
      paths.map(async (p) => {
        try {
          result.set(p, await readFile(join(root, p), "utf8"));
        } catch {
          // deleted in working tree
        }
      }),
    );
    return result;
  }

  const prefix = source.kind === "rev" ? `${source.rev}:` : ":";
  const blobs = await catFileBatch(root, paths.map((p) => prefix + p));
  paths.forEach((p, i) => {
    const b = blobs[i];
    if (b !== null) result.set(p, b);
  });
  return result;
}

/**
 * The patch between two sides (`git diff`), in the same form whatever the user's git config says:
 * a/ b/ prefixes, renames found, no colors, no external diff tool, paths from the repository root.
 * Untracked files are not in it (see untrackedFiles).
 */
export async function diffPatch(root: string, base: Source, target: Source): Promise<string> {
  const args = ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"];
  if (target.kind === "worktree" && base.kind === "index") return git(root, [...args, "--"]);
  if (base.kind !== "rev") throw new Error("比較元はコミットかステージ済みの状態です");
  if (target.kind === "rev") return git(root, [...args, base.rev, target.rev, "--"]);
  if (target.kind === "index") return git(root, [...args, "--cached", base.rev, "--"]);
  return git(root, [...args, base.rev, "--"]);
}

/** Files of the working tree that git does not track (respecting .gitignore), with their size */
export async function untrackedFiles(root: string): Promise<{ path: string; size: number }[]> {
  const out = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  // a nested repository is listed as "dir/"
  const paths = out.split("\0").filter((p) => p && !p.endsWith("/"));
  const files = await Promise.all(
    paths.map(async (path) => {
      try {
        const s = await stat(join(root, path));
        return s.isFile() ? { path, size: s.size } : null;
      } catch {
        return null; // removed meanwhile
      }
    }),
  );
  return files.filter((f): f is { path: string; size: number } => f !== null);
}

/**
 * The working tree as a git tree: every tracked and untracked file (respecting .gitignore) as it is now.
 * Built in an index of its own, so neither the working tree nor what is staged changes.
 */
export async function worktreeTree(root: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "diffshape-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    // start from the real index: git then only reads the files that changed since
    const real = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    await copyFile(real, env.GIT_INDEX_FILE).catch(() => {}); // no index yet: every file is read
    await git(root, ["add", "-A"], env);
    return (await git(root, ["write-tree"], env)).trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Where the working tree is kept before an agent edits it (a commit that no branch holds) */
export const SNAPSHOT_REF = "refs/diffshape/before-fix";

/**
 * Keeps the working tree as it is now under SNAPSHOT_REF and returns that commit, so the edits made
 * after it can be seen on their own (`diffshape . refs/diffshape/before-fix`) or taken back.
 */
export async function snapshotWorktree(root: string): Promise<string> {
  const tree = await worktreeTree(root);
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then(
    (s) => s.trim(),
    () => "", // no commit yet
  );
  // the user may have no name set: a snapshot must not fail for that
  const who = { GIT_AUTHOR_NAME: "diffshape", GIT_AUTHOR_EMAIL: "diffshape@localhost", GIT_COMMITTER_NAME: "diffshape", GIT_COMMITTER_EMAIL: "diffshape@localhost" };
  const commit = (await git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "diffshape: the working tree before an AI fix"], who)).trim();
  await git(root, ["update-ref", SNAPSHOT_REF, commit]);
  return commit;
}

/** Files of the working tree that differ from a commit (a snapshot), untracked files included */
export async function changedSince(root: string, commit: string): Promise<string[]> {
  const tree = await worktreeTree(root);
  const out = await git(root, ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", commit, tree, "--"]);
  return out.split("\0").filter(Boolean);
}

/** One file's bytes on one side, or null when it is not there */
export async function readBlob(root: string, source: Source, path: string): Promise<Buffer | null> {
  if (source.kind === "worktree") {
    try {
      return await readFile(join(root, path));
    } catch {
      return null;
    }
  }
  const spec = `${source.kind === "rev" ? source.rev : ""}:${path}`;
  return new Promise((resolve) => {
    execFile("git", ["cat-file", "blob", spec], { cwd: root, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Runs `git cat-file --batch` and returns contents in request order (null when missing). */
function catFileBatch(root: string, specs: string[]): Promise<(string | null)[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], { cwd: root });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
      const buf = Buffer.concat(chunks);
      const out: (string | null)[] = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i++) {
        const nl = buf.indexOf(0x0a, pos);
        const header = buf.subarray(pos, nl).toString("utf8");
        pos = nl + 1;
        if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
          out.push(null);
          continue;
        }
        const size = Number(header.split(" ")[2]);
        out.push(buf.subarray(pos, pos + size).toString("utf8"));
        pos += size + 1; // trailing LF
      }
      resolve(out);
    });
    proc.stdin.end(specs.join("\n") + "\n");
  });
}
