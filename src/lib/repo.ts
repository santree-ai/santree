/** Repo-name helpers shared across views. Two different splits, deliberately kept
 *  apart: GitHub slugs are `owner/name` (first slash), while a session's repo name
 *  can be any nested path whose *last* segment is the repo. */

/** Split a GitHub `owner/name` slug into its parts. Extra slashes stay with the
 *  name; a slug with no slash yields an empty name. */
export function splitRepoSlug(slug: string): [owner: string, name: string] {
  const [owner, ...rest] = slug.split("/");
  return [owner, rest.join("/")];
}

/** Split a repo name into its parent folder (everything before the last slash) and
 *  its short label. A name without a slash is its own folder. */
export function splitRepoPath(repo: string): { folder: string; label: string } {
  const i = repo.lastIndexOf("/");
  return i === -1
    ? { folder: repo, label: repo }
    : { folder: repo.slice(0, i), label: repo.slice(i + 1) };
}
