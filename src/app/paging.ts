/** Cursor pages (foundations §10, `listOf` in the spec): `{object: "list", data, has_more, url}`. */

export type Page<T> = {
  object: "list";
  data: T[];
  has_more: boolean;
  url: string;
};

/**
 * Builds a page from `limit + 1` rows read in page order (forward) or in reverse page order
 * (`ending_before`): the extra row only tells whether more exist in the direction read.
 */
export function pageOf<R, T>(rows: R[], limit: number, backwards: boolean, url: string, map: (r: R) => T): Page<T> {
  const has_more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (backwards) page.reverse();
  return { object: "list", data: page.map(map), has_more, url };
}
