/** A graph's home when it is shared: every session shows it (graph homes spec). Session ids are slugs, so this never collides. */
export const SHARED_HOME = '@shared';
export const isSharedHome = (value: string): boolean => value === SHARED_HOME;
