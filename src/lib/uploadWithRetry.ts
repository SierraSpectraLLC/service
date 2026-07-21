/**
 * Resilient upload wrapper for flaky (mobile) connections.
 *
 * Symptoms it fixes: a Vercel Blob upload freezes at a fixed percentage (61%,
 * or 0% at the very start) and never resolves or rejects - a stalled multipart
 * part/PUT that hangs with no error.
 *
 * Design notes (both matter):
 *  - Stall is detected on *forward* progress only. The SDK emits an initial
 *    0% event and can repeat the same value; resetting the watchdog on every
 *    event (including 0%) is what let a stuck-at-0% upload hang forever.
 *  - The attempt is raced against a stall promise that REJECTS, so control flow
 *    never depends on the underlying upload honoring the abort signal. Even if
 *    it ignores the abort, the race rejects, we retry, and after `maxAttempts`
 *    a real error is thrown (never a silent freeze).
 *
 * `uploadFn` is injected so this is testable without a real Blob store.
 */
export type UploadFn<T> = (signal: AbortSignal, onProgress: (pct: number) => void) => Promise<T>;

export type RetryOptions<T> = {
  uploadFn: UploadFn<T>;
  onProgress?: (pct: number) => void;
  onAttempt?: (attempt: number, reason: "stalled" | "error") => void; // a retry is starting
  stallMs?: number;      // abort an attempt if progress hasn't advanced for this long
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class UploadStalledError extends Error {
  constructor(public gotProgress: boolean) {
    super(gotProgress ? "stalled mid-transfer" : "upload did not start");
    this.name = "UploadStalledError";
  }
}

export async function uploadWithRetry<T>(opts: RetryOptions<T>): Promise<T> {
  const {
    uploadFn,
    onProgress = () => {},
    onAttempt = () => {},
    stallMs = 30_000,
    maxAttempts = 3,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr: unknown;
  let everGotProgress = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let maxPct = -1;               // highest percentage seen this attempt
    let stalled = false;
    let rejectStall!: (e: Error) => void;

    const stallPromise = new Promise<never>((_res, rej) => { rejectStall = rej; });
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();                       // best-effort cancel of the real upload
        rejectStall(new UploadStalledError(everGotProgress)); // guarantees the race rejects
      }, stallMs);
    };
    arm(); // guard the connect/first-byte window too

    try {
      const result = await Promise.race([
        uploadFn(controller.signal, (pct) => {
          if (pct > maxPct) { maxPct = pct; if (pct > 0) everGotProgress = true; arm(); } // reset ONLY on forward progress
          onProgress(pct);
        }),
        stallPromise,
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      // A stalled attempt always surfaces as UploadStalledError, even when the
      // underlying upload's own abort rejection wins the race.
      lastErr = stalled ? new UploadStalledError(everGotProgress) : e;
      if (attempt < maxAttempts) {
        onAttempt(attempt + 1, stalled ? "stalled" : "error");
        onProgress(0);
        await sleep(1000 * attempt); // brief backoff
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upload failed");
}
