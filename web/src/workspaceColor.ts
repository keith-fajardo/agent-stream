/** How many theme chart colours workspace badges cycle through (styles.css: .ws-color-0 … .ws-color-5). */
export const WORKSPACE_COLORS = 6;

/** Steps that share a workspace share a badge colour: a hash of the name picks it (spec §7). */
export function workspaceColor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % WORKSPACE_COLORS;
}
