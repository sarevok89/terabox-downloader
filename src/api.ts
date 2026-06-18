import type { Config } from './config.ts';

export const ERRNO: Record<number, string> = {
  2: 'parameter error (endpoint/params likely changed)',
  [-6]: 'auth failed — cookie/ndus is wrong or expired',
  [-9]: 'file or directory does not exist (check the path)',
  31034: 'hit rate limit — add a delay between files',
};

export interface TeraBoxItem {
  path: string;
  fs_id: string;
  isdir: number;
  size: number;
  server_filename: string;
}

/** Thin fetch wrapper that throws on non-2xx status. */
async function apiFetch(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

/** Throws a human-readable error when the TeraBox API returns a non-zero errno. */
function checkErrno(data: Record<string, unknown>, label: string): typeof data {
  const errno = (data.errno as number) ?? 0;
  if (errno !== 0) {
    const msg = ERRNO[errno] ?? 'see raw response';
    throw new Error(`${label} → errno ${errno}: ${msg}\n${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Returns jsToken from config if set; otherwise scrapes it from the TeraBox
 * homepage HTML via URL-encoded patterns found in the page's inline scripts.
 */
export async function getJsToken(cfg: Config, headers: Record<string, string>): Promise<string> {
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

  throw new Error(
    'Could not auto-extract jsToken. Grab it from a /api/list request in ' +
      'DevTools (Network tab) and set it in the config as "jsToken".',
  );
}

export async function apiList(
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

/** Resolves the direct download link (dlink) for a remote file path via the filemetas endpoint. */
export async function getDlink(headers: Record<string, string>, filePath: string): Promise<string> {
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
