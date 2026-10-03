/** What "Refine with planner" asks (step descriptions spec §6.2): a short chat line, and the planner's full instruction. */
export function refineRequest(nodeIds: string[]): { display: string; prompt: string } {
  const ids = nodeIds.join(', ');
  return {
    display: `Refine ${ids}`,
    prompt: `Refine step(s) ${ids}. For each, read its title, description and prompt (or command) with get_graph; the user may have written them in plain language without technical detail. Investigate the repository as needed. Then use update_node to write (1) a precise, detailed prompt for an agent step — or the exact shell command for a command step — that carries out the user's intent, and (2) a one-sentence plain-language description a non-technical reader can review. Keep the user's intent; do not change any step's kind, its connections, or other steps. Reply with one line per step saying what you changed.`,
  };
}
