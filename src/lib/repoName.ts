/** The repo's own name without its owner prefix. Registration derives an
 *  `owner/repo` name, and the owner is the same for nearly every row — it costs
 *  a column's worth of width to say nothing. Keep the full name as the title. */
export function shortRepoName(repo: string): string {
  const at = repo.lastIndexOf("/");
  return at === -1 ? repo : repo.slice(at + 1);
}
