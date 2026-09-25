// CLI entry for scripts/alerts.mjs, kept separate so the engine module has no
// side effects on import (the tests import it). The real run needs the
// TypeScript screener, so it goes through vite-node (`npm run alerts`); the
// --test and --mock checks run under plain `node scripts/alerts-run.mjs`.
import { main } from "./alerts.mjs";

main().catch((e) => {
  // The message only — never the request URL, which carries the bot token.
  console.error(`::error::${e.message}`);
  process.exit(1);
});
