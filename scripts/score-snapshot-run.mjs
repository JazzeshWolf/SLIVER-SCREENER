// CLI entry for scripts/score-snapshot.mjs (kept separate so tests can import
// the module without running it). Needs the TypeScript screener, so it runs
// under vite-node:  npm run -s score -- --data <dir> --out <file> [--prev <file>]
import { main } from "./score-snapshot.mjs";

main().catch((e) => {
  console.error(`::error::${e.message}`);
  process.exit(1);
});
