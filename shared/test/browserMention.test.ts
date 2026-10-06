import { describe, expect, it } from 'vitest';
import { browserMention, browserMentionHint, browserOffWarning, BROWSER_MENTION_TITLE, TURN_ON_BROWSER, type GraphNode } from '../src';

const step = (over: Partial<GraphNode> = {}): GraphNode => ({ id: 'n1', title: 'Research', kind: 'agent', prompt: 'Summarise the repo.', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });

describe('browserMention', () => {
  it('finds each phrase, in the prompt, the title or the description, whatever its case', () => {
    expect(browserMention(step({ prompt: 'Use browser to research them on the web.' }))).toBe('browser');
    expect(browserMention(step({ prompt: 'Look them up on LinkedIn.' }))).toBe('linkedin');
    expect(browserMention(step({ prompt: 'Please LOG IN first.' }))).toBe('log in');
    expect(browserMention(step({ prompt: 'Open the login page.' }))).toBe('login');
    expect(browserMention(step({ prompt: 'You are logged in already.' }))).toBe('logged in');
    expect(browserMention(step({ prompt: 'Sign in with the shared account.' }))).toBe('sign in');
    expect(browserMention(step({ prompt: 'Go to the signin page.' }))).toBe('signin');
    expect(browserMention(step({ prompt: 'Once signed in, export the list.' }))).toBe('signed in');
    expect(browserMention(step({ prompt: 'Solve the CAPTCHA if shown.' }))).toBe('captcha');
    expect(browserMention(step({ title: 'Check LinkedIn', prompt: 'p' }))).toBe('linkedin');
    expect(browserMention(step({ description: 'Needs a login.', prompt: 'p' }))).toBe('login');
  });

  it('returns the first match: title, then description, then prompt, and the earliest in a field', () => {
    expect(browserMention(step({ title: 'Browser research', description: 'LinkedIn', prompt: 'login' }))).toBe('browser');
    expect(browserMention(step({ title: 'Research', description: 'Uses captcha', prompt: 'Use the browser' }))).toBe('captcha');
    expect(browserMention(step({ prompt: 'Sign in to LinkedIn in the browser.' }))).toBe('sign in');
  });

  it('matches whole words only: browsers, loginForm, login_form and catalog in do not count', () => {
    expect(browserMention(step({ prompt: 'Test across browsers.' }))).toBeUndefined();
    expect(browserMention(step({ prompt: 'Rename loginForm to LoginForm.' }))).toBeUndefined();
    expect(browserMention(step({ prompt: 'Edit login_form.ts and the signinPage.' }))).toBeUndefined();
    expect(browserMention(step({ prompt: 'Add the item to the catalog in the config.' }))).toBeUndefined();
    expect(browserMention(step({ prompt: 'A linkedinfoo b linkedin_x.' }))).toBeUndefined();
    // Punctuation and hyphens are boundaries.
    expect(browserMention(step({ prompt: "Use the browser's tabs." }))).toBe('browser');
    expect(browserMention(step({ prompt: 'A browser-based check.' }))).toBe('browser');
    expect(browserMention(step({ prompt: 'Log\n  in, then go.' }))).toBe('log in');
  });

  it('ignores generic words like web, website, search and online', () => {
    expect(browserMention(step({ title: 'Web search', description: 'Look online', prompt: 'Search the website and the web.' }))).toBeUndefined();
  });

  it('never matches a command step or a step with Browser on', () => {
    expect(browserMention(step({ kind: 'command', command: 'open https://linkedin.com', prompt: undefined, title: 'Open LinkedIn' }))).toBeUndefined();
    expect(browserMention(step({ browser: true, prompt: 'Use the browser on LinkedIn.' }))).toBeUndefined();
    expect(browserMention(step({ browser: false, prompt: 'Use the browser.' }))).toBe('browser');
  });

  it('copes with a step that has no description or prompt', () => {
    expect(browserMention(step({ prompt: undefined }))).toBeUndefined();
  });
});

describe('browser mention strings', () => {
  it('say what the brief says', () => {
    expect(browserMentionHint('linkedin')).toBe('This step mentions "linkedin", but Browser is off, so it can\'t use your logged-in browser.');
    expect(TURN_ON_BROWSER).toBe('Turn on Browser');
    expect(BROWSER_MENTION_TITLE).toBe('Mentions the browser, but Browser is off');
    expect(browserOffWarning('n3', 'linkedin')).toBe('n3 mentions "linkedin", but Browser is off: it will use plain web search, not your logged-in browser.');
  });
});
