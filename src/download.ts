import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { CONCURRENCY } from './config.ts';
import { apiList, getDlink, type TeraBoxItem } from './api.ts';
import { Semaphore, ProgressDisplay } from './progress.ts';

/** Recursively expands remoteDir into a flat list of all files, traversing subdirectories. */
export async function collectFiles(
  cfg: Config,
  headers: Record<string, string>,
  jsToken: string,
  remoteDir: string,
): Promise<TeraBoxItem[]> {
  const items = await apiList(cfg, headers, jsToken, remoteDir);
  const files: TeraBoxItem[] = [];
  for (const item of items) {
    if (item.isdir) {
      files.push(...(await collectFiles(cfg, headers, jsToken, item.path)));
    } else {
      files.push(item);
    }
  }
  return files;
}

/**
 * Downloads dlink to dest, streaming through a `.part` temp file and atomically
 * renaming on completion. Skips the file if dest already exists.
 */
export async function downloadFile(
  headers: Record<string, string>,
  dlink: string,
  dest: string,
  onProgress: (downloaded: number) => void,
): Promise<'done' | 'skipped'> {
  if (fs.existsSync(dest)) return 'skipped';

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(dlink, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const fileStream = fs.createWriteStream(tmp);
  let downloaded = 0;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      fileStream.write(chunk);
      downloaded += chunk.byteLength;
      onProgress(downloaded);
    }
  } catch (err) {
    fileStream.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err: Error | null) => (err ? reject(err) : resolve()));
  });

  fs.renameSync(tmp, dest);
  return 'done';
}

/** Concurrently downloads all files under a semaphore-bounded pool with a live progress display. */
export async function downloadAll(
  files: TeraBoxItem[],
  headers: Record<string, string>,
  localRoot: string,
): Promise<ProgressDisplay> {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const sem = new Semaphore(CONCURRENCY);
  const display = new ProgressDisplay(files.length, totalBytes);

  display.start();

  await Promise.all(
    files.map(async (file) => {
      await sem.acquire();
      const local = path.join(localRoot, file.path.replace(/^\//, ''));
      const slot = display.allocSlot(file.server_filename, file.size);
      try {
        const dlink = await getDlink(headers, file.path);
        const result = await downloadFile(headers, dlink, local, (n) => display.update(slot, n));
        display.finish(slot, result);
      } catch {
        display.finish(slot, 'failed');
      } finally {
        sem.release();
      }
    }),
  );

  display.stop();
  return display;
}
