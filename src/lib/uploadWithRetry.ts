/**
 * Resilient upload wrapper for flaky (mobile) connections.
 *
 * The symptom it fixes: a Vercel Blob upload freezes at a fixed percentage
 * (e.g. 61%) and never resolves or rejects - a stalled multipart part or PUT
 * that hangs with no error. This wraps the raw upload with a stall watchdog
 * (abort if no progress for `stallMs`) and retries the whole file up to
 * `maxAttempts` times with a fresh connection.
 *
 * `uploadFn` is injected so the retry logic is testable without a real Blob
 * store: it receives an AbortSignal and a progress callback and resolves with
 * the uploaded blob (any shape).
 */
export type UploadFn<T> = (signal: AbortSignal, onProgress: (pct: number) => void) => Promise<T>;

export type RetryOptions<T> = {
  uploadFn: UploadFn<T>;
  onProgress?: (pct: number) => void;
  onAttempt?: (attempt: number, reason: string) => void; // called when a retry is about to start
  stallMs?: number;      // abort an attempt if no progress arrives for this long
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const isAbort = (e: unknown) =>
  e instanceof Error && (e.name === "AbortError" || /abort|stall/i.test(e.message));

export async function uploadWithRetry<T>(opts: RetryOptions<T>): Promise<T> {
  const {
    uploadFn,
    onProgress = () => {},
    onAttempt = () => {},
    stallMs = 45_000,
    maxAttempts = 3,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(new Error("stalled: no progress")), stallMs);
    };
    arm(); // guard the initial connect/first-byte too

    try {
      const result = await uploadFn(controller.signal, (pct) => {
        arm(); // progress means we're alive - reset the stall timer
        onProgress(pct);
      });
      if (watchdog) clearTimeout(watchdog);
      return result;
    } catch (e) {
      if (watchdog) clearTimeout(watchdog);
      lastErr = e;
      const stalled = controller.signal.aborted || isAbort(e);
      if (attempt < maxAttempts) {
        onAttempt(attempt + 1, stalled ? "stalled" : "error");
        onProgress(0);
        await sleep(1000 * attempt); // brief backoff before the next attempt
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upload failed");
}
