#!/usr/bin/env node
// `clearcote` command-line entry. All logic lives in ./cli-commands.ts so it can be imported and
// tested without running anything; this file only runs it.
import { main } from "./cli-commands.js";

main().catch((e) => {
  process.stderr.write(`clearcote: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
