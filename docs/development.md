# Development

```bash
npm install
npm test                                   # unit tests (shared, engine, web, extension)
                                           # (engine: drives your Chrome, Edge or Chromium headless when one is installed; skipped otherwise)
npm run typecheck
npm run build                              # web UI + extension bundle
npm run test:integration -w extension      # real VS Code (downloads it once)
node extension/scripts/screenshots.mjs     # screenshots for a visual check
AGENT_STREAM_LIVE=1 npm test -w engine -- live   # real Claude, small plan usage
AGENT_STREAM_LIVE=1 npm run test:integration -w extension   # also runs one agent step through the bundle
```
