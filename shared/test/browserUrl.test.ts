import { describe, expect, it } from 'vitest';
import { loggedUrl } from '../src/browser';

describe('loggedUrl', () => {
  it('leaves an ordinary URL exactly as it is', () => {
    expect(loggedUrl('https://a.example/search?q=jobs&page=2')).toBe('https://a.example/search?q=jobs&page=2');
    expect(loggedUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('strips the username and password', () => {
    expect(loggedUrl('https://user:secret@a.example/x')).toBe('https://a.example/x');
    expect(loggedUrl('https://token@a.example/')).toBe('https://a.example/');
  });

  it('drops the fragment, where OAuth implicit-flow tokens live, and keeps the query', () => {
    expect(loggedUrl('https://app.example/cb#access_token=abc&state=1')).toBe('https://app.example/cb');
    expect(loggedUrl('https://app.example/cb?code=1#id_token=z')).toBe('https://app.example/cb?code=1');
    expect(loggedUrl('https://app.example/page#')).toBe('https://app.example/page');
  });

  it('returns what is not a URL unchanged', () => {
    expect(loggedUrl('not a url')).toBe('not a url');
  });
});
