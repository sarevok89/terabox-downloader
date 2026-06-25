import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { CONCURRENCY, MAX_CONSECUTIVE_FAILURES } from './config.ts';
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

function localPathFor(localRoot: string, file: TeraBoxItem): string {
  return path.join(localRoot, file.path.replace(/^\//, ''));
}

/**
 * Downloads dlink to dest, streaming through a `.part` temp file and atomically
 * renaming on completion. Skips the file if dest already exists. If a `.part`
 * file is left over from an interrupted run, resumes it via a Range request;
 * falls back to a full restart if the server doesn't honor the range.
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
  let resumeFrom = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;

  let res = await fetch(dlink, {
    headers: resumeFrom > 0 ? { ...headers, Range: `bytes=${resumeFrom}-` } : headers,
    redirect: 'follow',
  });

  if (resumeFrom > 0 && res.status !== 206) {
    await res.body?.cancel();
    resumeFrom = 0;
    res = await fetch(dlink, { headers, redirect: 'follow' });
  }

  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const fileStream = fs.createWriteStream(tmp, resumeFrom > 0 ? { flags: 'a' } : undefined);
  fileStream.on('error', () => {});
  let downloaded = resumeFrom;
  onProgress(downloaded);

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      fileStream.write(chunk);
      downloaded += chunk.byteLength;
      onProgress(downloaded);
    }
  } catch (err) {
    fileStream.destroy();
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
  const alreadyDownloaded = files.reduce(
    (sum, f) => (fs.existsSync(localPathFor(localRoot, f)) ? sum + f.size : sum),
    0,
  );
  const sem = new Semaphore(CONCURRENCY);
  const display = new ProgressDisplay(files.length, totalBytes, localRoot, alreadyDownloaded);

  display.start();

  let consecutiveFailures = 0;

  await Promise.all(
    files.map(async (file) => {
      await sem.acquire();
      if (display.aborted) {
        sem.release();
        return;
      }
      const local = localPathFor(localRoot, file);
      const slot = display.allocSlot(file.server_filename, file.size, path.dirname(local));
      try {
        const dlink = await getDlink(headers, file.path);
        const result = await downloadFile(headers, dlink, local, (n) => display.update(slot, n));
        display.finish(slot, result);
        consecutiveFailures = 0;
      } catch (err) {
        display.finish(slot, 'failed', (err as Error).message);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) display.aborted = true;
      } finally {
        sem.release();
      }
    }),
  );

  display.stop();
  return display;
}
