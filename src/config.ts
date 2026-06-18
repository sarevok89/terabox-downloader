import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const CONCURRENCY = 5;

export interface Config {
  cookie: string;
  jsToken?: string;
  base: string;
}

const CONFIG_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'terabox_config.ts');

export async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH} — create it first (see file header).`);
  }
  const mod = await import(pathToFileURL(CONFIG_PATH).href);
  const cfg: Config = { base: 'https://www.terabox.com', ...mod.default };
  if (!cfg.cookie?.includes('ndus=')) {
    throw new Error("Config needs a 'cookie' string containing 'ndus=...'");
  }
  return cfg;
}

export function makeHeaders(cfg: Config): Record<string, string> {
  return { 'User-Agent': UA, Referer: `${cfg.base}/`, Cookie: cfg.cookie, 'X-Requested-With': 'XMLHttpRequest' };
}
