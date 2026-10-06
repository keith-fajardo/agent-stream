/** http: and https: only (spec §4.3). Anything that doesn't parse is not a web address. */
export function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The site an approval covers: the URL's host with its port (ruling R5); '' when it isn't a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** scheme + host + port of a web address; '' for anything else. What "Allow on this site" is keyed by: http and https, ports and subdomains are different sites. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

/** How a card names a site: the host (with its port) of an https address, `http://host` for plain http; '' when it isn't a web address. */
export function siteLabel(url: string): string {
  const origin = originOf(url);
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin;
}
