export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
