/**
 * NECROFALL — yield to the browser between chunks of a long build.
 *
 * `setTimeout(0)` LOOKS like a safe yield but is a TRAP for loading screens: an occluded /
 * background tab clamps timers to 1 s (Chrome's intensive throttling goes far lower still), so a
 * build with ~100 chunk yields stretched from seconds to MINUTES behind the loading screen (the
 * "loading screen gets stuck and never ends" bug). The VS Code integrated browser is treated as
 * occluded/hidden much of the time — exactly where the game is developed and tested — so this is
 * not a rare corner. `rAF` is no better: the same environment pauses it outright.
 *
 * A MessageChannel task is NOT a timer and keeps running at full speed while hidden: the build
 * progresses at CPU speed and simply paints less often. `scheduler.yield()` (Chromium 129+) is
 * preferred when it exists.
 */
interface SchedulerLike {
  yield?: () => Promise<void>;
}

const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;

const channel = new MessageChannel();
const waiters: Array<() => void> = [];
channel.port1.onmessage = () => waiters.shift()?.();

/** Resolve on the next TASK (not a timer) — safe under background timer throttling. */
export function yieldToMain(): Promise<void> {
  if (scheduler && typeof scheduler.yield === 'function') return scheduler.yield();
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
    channel.port2.postMessage(0);
  });
}
