import { CONCURRENCY } from './config.ts';

// ── Formatting helpers ────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function formatEta(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '--:--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function makeBar(fraction: number, width: number): string {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '[' + '█'.repeat(n) + '░'.repeat(width - n) + ']';
}

function truncate(s: string, max: number): string {
  return s.length > max ? '…' + s.slice(-(max - 1)) : s;
}

// ── Semaphore ─────────────────────────────────────────────────────────────────

/** Promise-based counting semaphore for bounding the number of concurrent downloads. */
export class Semaphore {
  private n: number;
  private waiters: Array<() => void> = [];

  constructor(n: number) {
    this.n = n;
  }

  acquire(): Promise<void> {
    if (this.n > 0) { this.n--; return Promise.resolve(); }
    return new Promise(r => this.waiters.push(r));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.n++;
  }
}

// ── Progress display ──────────────────────────────────────────────────────────

interface SlotState {
  name: string;
  size: number;
  downloaded: number;
  prevDownloaded: number;
  speed: number;
}

const BLOCK_LINES = CONCURRENCY + 2;

export class ProgressDisplay {
  private slots: Array<SlotState | null> = new Array(CONCURRENCY).fill(null);
  private pool: number[] = Array.from({ length: CONCURRENCY }, (_, i) => i);
  private totalFiles: number;
  private totalBytes: number;
  doneCount = 0;
  skippedCount = 0;
  failedCount = 0;
  downloadedBytes = 0;
  readonly startTime = Date.now();
  private overallSpeed = 0;
  private lastRenderTotal = 0;
  private lastRenderTime = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(totalFiles: number, totalBytes: number) {
    this.totalFiles = totalFiles;
    this.totalBytes = totalBytes;
  }

  /** Claims a free display row for a new in-progress file; caller must call finish() to release it. */
  allocSlot(name: string, size: number): number {
    const i = this.pool.shift()!;
    this.slots[i] = { name, size, downloaded: 0, prevDownloaded: 0, speed: 0 };
    return i;
  }

  update(slot: number, downloaded: number): void {
    const s = this.slots[slot];
    if (s) s.downloaded = downloaded;
  }

  finish(slot: number, result: 'done' | 'skipped' | 'failed'): void {
    const s = this.slots[slot];
    if (s) {
      if (result === 'done') { this.doneCount++; this.downloadedBytes += s.size; }
      else if (result === 'skipped') this.skippedCount++;
      else this.failedCount++;
    }
    this.slots[slot] = null;
    this.pool.push(slot);
  }

  start(): void {
    process.stdout.write('\n'.repeat(BLOCK_LINES));
    this.timer = setInterval(() => this.render(), 150);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.render();
  }

  private get activeBytes(): number {
    return this.slots.reduce((sum, s) => sum + (s?.downloaded ?? 0), 0);
  }

  private render(): void {
    const now = Date.now();
    const dt = Math.max((now - this.lastRenderTime) / 1000, 0.001);

    for (const s of this.slots) {
      if (s) {
        const delta = s.downloaded - s.prevDownloaded;
        s.speed = s.speed * 0.6 + (delta / dt) * 0.4;
        s.prevDownloaded = s.downloaded;
      }
    }

    const totalNow = this.downloadedBytes + this.activeBytes;
    const instant = (totalNow - this.lastRenderTotal) / dt;
    this.overallSpeed = this.overallSpeed * 0.7 + instant * 0.3;
    this.lastRenderTotal = totalNow;
    this.lastRenderTime = now;

    const finishedCount = this.doneCount + this.skippedCount + this.failedCount;
    const remaining = this.totalBytes - totalNow;
    const eta = this.overallSpeed > 10 ? remaining / this.overallSpeed : Infinity;
    const pct = this.totalBytes > 0 ? Math.round((totalNow / this.totalBytes) * 100) : 0;

    const lines: string[] = [
      `[${finishedCount}/${this.totalFiles} files]  ` +
        `${formatBytes(totalNow)} / ${formatBytes(this.totalBytes)}  ` +
        `${formatBytes(this.overallSpeed)}/s  ETA ${formatEta(eta)}  (${pct}%)`,
      '',
    ];

    for (const s of this.slots) {
      if (!s) { lines.push(''); continue; }
      const name = truncate(s.name, 28).padEnd(28);
      const frac = s.size > 0 ? s.downloaded / s.size : 0;
      const bar = makeBar(frac, 18);
      const pctStr = `${Math.round(frac * 100)}%`.padStart(4);
      const spd = `${formatBytes(s.speed)}/s`.padStart(11);
      lines.push(`  ${name}  ${bar}  ${pctStr}  ${spd}`);
    }

    process.stdout.write(`\x1b[${BLOCK_LINES}A`);
    process.stdout.write(lines.map(l => `\x1b[2K${l}`).join('\n') + '\n');
  }
}
