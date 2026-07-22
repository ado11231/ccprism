import { stat } from "node:fs/promises";

// Shared file follower for the live commands. Both modes of view
// --follow work the same way: stat one file on an interval and
// do the work only when it actually moved. Polling rather than
// fs.watch because the file is appended by another process and the
// platform watchers coalesce and occasionally drop those events,
// while a stat every second costs nothing.

export interface PollOptions {
  // One pass then return, for tests and non interactive use. The real
  // cli leaves this unset and loops until ctrl-c.
  once?: boolean;
  // Poll cadence in ms, overridable in tests.
  intervalMs?: number;
  // A programmatic stop, in addition to ctrl-c. The cli never sets
  // it; tests abort it to end the loop without raising SIGINT, which
  // the test runner also listens for.
  signal?: AbortSignal;
}

export interface PollHooks extends PollOptions {
  // Runs once when the loop ends, before the exit code is returned,
  // so a follower can flush whatever it was holding back. Not run in
  // once mode, which never started following.
  onStop?: () => Promise<void> | void;
}

export async function pollFile(
  filePath: string,
  hooks: PollHooks,
  onChange: () => Promise<void>,
): Promise<number> {
  let lastMtime = -1;
  let lastSize = -1;

  // True when the file looks different from the last look. Seeded
  // before the first pass so the loop's opening tick does not count
  // the file as changed.
  const moved = async (): Promise<boolean> => {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return false;
    }
    if (info.mtimeMs === lastMtime && info.size === lastSize) return false;
    lastMtime = info.mtimeMs;
    lastSize = info.size;
    return true;
  };

  await moved();
  await onChange();
  if (hooks.once === true) return 0;

  return await new Promise<number>((resolvePromise) => {
    const timer = setInterval(() => {
      void (async () => {
        if (await moved()) await onChange();
      })();
    }, hooks.intervalMs ?? 1000);

    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      process.off("SIGINT", stop);
      hooks.signal?.removeEventListener("abort", stop);
      void (async () => {
        await hooks.onStop?.();
        resolvePromise(0);
      })();
    };
    process.on("SIGINT", stop);
    hooks.signal?.addEventListener("abort", stop, { once: true });
    if (hooks.signal?.aborted === true) stop();
  });
}
