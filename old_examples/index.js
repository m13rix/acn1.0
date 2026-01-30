#!/usr/bin/env node

import { CLI } from './src/cli.js';

/**
 * Entry point for ACN Multi-Agent Framework
 */
async function main() {
  const cli = new CLI();
  await cli.start();
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

