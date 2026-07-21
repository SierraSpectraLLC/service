/**
 * Resilient upload wrapper for hostile networks.
 *
 * Two distinct failure modes it handles:
 *  - Mid-transfer stall (progress freezes at e.g. 61%): flaky connection.
 *    Abort and retry with a fresh connection, keeping progress reporting.
 *  - Never starts (stuck at 0% on a good connection): requesting upload
 *    progress makes @vercel/blob use fetch with a STREAMING request body,
 *    which requires HTTP/2 end-to-end. VPNs, TLS-inspecting security
 *    software, and hotel/corporate middleboxes downgrade to HTTP/1.1, where
 *    Chrome kills streaming uploads instantly - and the SDK's internal
 *    10x retry loop makes that look like a silent hang. The fallback:
 *    retry in "compat" mode WITHOUT progress reporting, which makes the SDK
 *    send a plain non-streaming body that works over HTTP/1.1.
 *
 * Watchdogs:
 *  - progress mode: abort if progress hasn't advanced for `stallMs`
 *    (forward progress only - the SDK emits/repeats 0% events).
 *  - compat mode: no progress events exist, so instead apply a generous
 *    overall cap `compatTimeoutMs`.
 * Every attempt is raced against a rejecting timer, so control flow never
 * depends on the SDK honoring the abort signal - no silent hangs, ever.
 *
 * `uploadFn` is injected so all of this is testable without a Blob store.
 */
export type UploadMode = "progress" | "compat";
export type UploadFn<T> = (signal: AbortSignal, onProgress: (pct: number) => void, mode: UploadMode) => Promise<T>;

export type RetryOptions<T> = {
  uploadFn: UploadFn<T>;
  onProgress?: (pct: number) => void;
  onAttempt?: (attempt: number, mode: UploadMode) => void; // a retry is starting
  stallMs?: number;         // progress mode: abort if progress hasn't advanced for this long
  compatTimeoutMs?: number; // compat mode: overall cap per attempt
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class UploadStalledError extends Error {
  constructor(public gotProgress: boolean, public mode: UploadMode) {
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
    compatTimeoutMs = 8 * 60_000,
    maxAttempts = 3,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  let lastErr: unknown;
  let mode: UploadMode = "progress";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let maxPct = -1;   // highest percentage seen this attempt
    let stalled = false;
    let rejectStall!: (e: Error) => void;
    const stallPromise = new Promise<never>((_res, rej) => { rejectStall = rej; });

    const trip = () => {
      stalled = true;
      controller.abort();                                  // best-effort cancel
      rejectStall(new UploadStalledError(maxPct > 0, mode)); // guarantees the race rejects
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(trip, mode === "progress" ? stallMs : compatTimeoutMs);
    };
    arm(); // progress mode: guards connect/first-byte; compat mode: the overall cap

    try {
      const result = await Promise.race([
        uploadFn(controller.signal, (pct) => {
          // Reset ONLY on forward progress, and only in progress mode -
          // compat mode's timer is an overall cap, not a stall detector.
          if (pct > maxPct) { maxPct = pct; if (mode === "progress") arm(); }
          onProgress(pct);
        }, mode),
        stallPromise,
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      // A tripped watchdog always surfaces as UploadStalledError, even when the
      // SDK's own abort rejection wins the race.
      lastErr = stalled ? new UploadStalledError(maxPct > 0, mode) : e;
      if (attempt < maxAttempts) {
        // Never-started in progress mode -> the streaming transport is likely
        // being blocked by the network path; all further attempts go compat.
        if (mode === "progress" && maxPct <= 0) mode = "compat";
        onAttempt(attempt + 1, mode);
        onProgress(0);
        await sleep(1000 * attempt); // brief backoff
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upload failed");
}
