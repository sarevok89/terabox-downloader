#!/usr/bin/env tsx
/**
 * terabox-downloader.ts — recursively download a directory from your TeraBox
 * account using TeraBox's undocumented web API and your browser session cookie.
 *
 * Usage:
 *   npx tsx terabox-downloader.ts "/remote/folder"
 *   npx tsx terabox-downloader.ts "/remote/folder" "/local/dest"
 *
 * Setup — fill in terabox_config.ts (a template is provided next to this file).
 *
 * Get your cookie by opening TeraBox in your browser, opening DevTools →
 * Network, refreshing, clicking any request to terabox.com and copying the
 * full Cookie header value.
 */

import os from 'node:os';
import path from 'node:path';
import { loadConfig, makeHeaders, MAX_CONSECUTIVE_FAILURES } from './src/config.ts';
import { getJsToken } from './src/api.ts';
import { formatBytes, formatEta, shortReason } from './src/progress.ts';
import { collectFiles, downloadAll } from './src/download.ts';

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    die(
      'Usage:\n' +
        '  npx tsx terabox-downloader.ts "/remote/dir"\n' +
        '  npx tsx terabox-downloader.ts "/remote/dir" "/local/dest"',
    );
  }

  const remote = args[0];
  const local = args[1] ?? path.join(os.homedir(), 'Downloads', 'terabox');
  const cfg = await loadConfig();
  const headers = makeHeaders(cfg);

  process.stdout.write('Authenticating...');
  const jsToken = await getJsToken(cfg, headers);
  process.stdout.write(' OK\n');

  process.stdout.write(`Collecting files in ${remote}...`);
  const files = await collectFiles(cfg, headers, jsToken, remote);
  if (files.length === 0) {
    console.log('\nNo files found.');
    return;
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  console.log(` ${files.length} files (${formatBytes(totalBytes)})`);

  const display = await downloadAll(files, headers, local);
  const elapsed = (Date.now() - display.startTime) / 1000;

  const parts = [
    display.aborted
      ? `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (${formatEta(elapsed)}).`
      : `Done in ${formatEta(elapsed)}.`,
    `Downloaded: ${display.doneCount}`,
    `Skipped: ${display.skippedCount}`,
    ...(display.failedCount ? [`Failed: ${display.failedCount}`] : []),
    `Total: ${formatBytes(display.downloadedBytes)}`,
  ];
  console.log('\n' + parts.join('  '));

  if (display.failures.length) {
    const counts = new Map<string, number>();
    for (const f of display.failures) {
      const reason = shortReason(f.reason);
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    console.log('\nFailure reasons:');
    for (const [reason, count] of counts) {
      console.log(`  ${count}x  ${reason}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
