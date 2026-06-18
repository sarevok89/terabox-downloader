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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const CONFIG_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'terabox_config.ts');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ERRNO: Record<number, string> = {
  2: 'parameter error (endpoint/params likely changed)',
  [-6]: 'auth failed — cookie/ndus is wrong or expired',
  [-9]: 'file or directory does not exist (check the path)',
  31034: 'hit rate limit — add a delay between files',
};

interface Config {
  cookie: string;
  jsToken?: string;
  base: string;
}

interface TeraBoxItem {
  path: string;
  fs_id: string;
  isdir: number;
  size: number;
  server_filename: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(CONFIG_PATH)) {
    die(`Missing ${CONFIG_PATH} — create it first (see file header).`);
  }
  const mod = await import(pathToFileURL(CONFIG_PATH).href);
  const cfg: Config = { base: 'https://www.terabox.com', ...mod.default };
  if (!cfg.cookie?.includes('ndus=')) {
    die("Config needs a 'cookie' string containing 'ndus=...'");
  }
  return cfg;
}

function makeHeaders(cfg: Config): Record<string, string> {
  return { 'User-Agent': UA, Referer: `${cfg.base}/`, Cookie: cfg.cookie, 'X-Requested-With': 'XMLHttpRequest' };
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function checkErrno(data: Record<string, unknown>, label: string): typeof data {
  const errno = (data.errno as number) ?? 0;
  if (errno !== 0) {
    const msg = ERRNO[errno] ?? 'see raw response';
    throw new Error(`${label} → errno ${errno}: ${msg}\n${JSON.stringify(data)}`);
  }
  return data;
}

async function getJsToken(cfg: Config, headers: Record<string, string>): Promise<string> {
  if (cfg.jsToken) return cfg.jsToken;

  const res = await fetch(`${cfg.base}/main?category=all`, { headers });
  const html = await res.text();

  const patterns = [
    /%22jsToken%22%3A%22([0-9A-Fa-f]{30,})%22/,
    /jsToken%22?\s*[:=]\s*%22?([0-9A-Fa-f]{30,})/,
    /fn%28%22([0-9A-Fa-f]{30,})%22%29/,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return m[1];
  }

  die(
    'Could not auto-extract jsToken. Grab it from a /api/list request in ' +
      'DevTools (Network tab) and set it in the config as "jsToken".',
  );
}

async function apiList(
  cfg: Config,
  headers: Record<string, string>,
  jsToken: string,
  remoteDir: string,
): Promise<TeraBoxItem[]> {
  const params = new URLSearchParams({
    app_id: '250528',
    web: '1',
    channel: 'dubox',
    clienttype: '0',
    jsToken,
    dir: remoteDir,
    order: 'name',
    desc: '0',
    num: '1000',
    page: '1',
  });

  const data = checkErrno(
    (await apiFetch(`${cfg.base}/api/list?${params}`, headers)) as Record<string, unknown>,
    `list ${remoteDir}`,
  );
  return (data.list as TeraBoxItem[]) ?? [];
}

async function getDlink(cfg: Config, headers: Record<string, string>, filePath: string): Promise<string> {
  const params = new URLSearchParams({
    app_id: '250528',
    web: '1',
    channel: 'dubox',
    client: 'web',
    clienttype: '35',
    bdstoken: '',
    target: JSON.stringify([filePath]),
    dlink: '1',
  });

  const data = checkErrno(
    (await apiFetch(`https://nephobox.com/api/filemetas?${params}`, headers)) as Record<string, unknown>,
    `filemetas ${filePath}`,
  );
  return (data.info as Array<{ dlink: string }>)[0].dlink;
}

// ── Download ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

async function downloadFile(
  headers: Record<string, string>,
  dlink: string,
  dest: string,
  totalSize: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) {
    console.log(`  skip (exists): ${dest}`);
    return;
  }

  const tmp = `${dest}.part`;
  const res = await fetch(dlink, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} downloading file`);
  }

  const fileStream = fs.createWriteStream(tmp);
  let downloaded = 0;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      fileStream.write(chunk);
      downloaded += chunk.byteLength;
      const pct = totalSize > 0 ? ` ${Math.round((downloaded / totalSize) * 100)}%` : '';
      process.stdout.write(`\r  ${formatBytes(downloaded)} / ${formatBytes(totalSize)}${pct}   `);
    }
    process.stdout.write('\n');
  } catch (err) {
    fileStream.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err: Error | null) => (err ? reject(err) : resolve()));
  });

  fs.renameSync(tmp, dest);
  console.log(`  done: ${dest}`);
}

// ── Recursive walk ────────────────────────────────────────────────────────────

async function walk(
  cfg: Config,
  headers: Record<string, string>,
  jsToken: string,
  remoteDir: string,
  localRoot: string,
): Promise<void> {
  const items = await apiList(cfg, headers, jsToken, remoteDir);

  for (const item of items) {
    if (item.isdir) {
      await walk(cfg, headers, jsToken, item.path, localRoot);
    } else {
      const local = path.join(localRoot, item.path.replace(/^\//, ''));
      console.log(`\nfile: ${item.path}  (${formatBytes(item.size)})`);
      try {
        const dlink = await getDlink(cfg, headers, item.path);
        await downloadFile(headers, dlink, local, item.size);
      } catch (e) {
        console.error(`  FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

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
  const jsToken = await getJsToken(cfg, headers);

  console.log(`jsToken OK.\nMirroring: ${remote}\n      → ${local}\n`);
  await walk(cfg, headers, jsToken, remote, local);
  console.log('\nFinished.');
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message ?? err);
  process.exit(1);
});
