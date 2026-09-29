// NECROFALL — the shell's notification chime (user ask 2026-09-29: new followers
// and lobby invites raise a notification AT TOP LEFT **and a notification sound**).
//
// A tiny two-note WebAudio chime — no assets, no AudioManager dependency (the game's
// mixer belongs to the match; the shell must be able to ring while a menu is up).
// Browsers block audio until a user gesture; every path that reaches here follows a
// click/keypress, and a suspended context is resumed on the spot. Failures are silent:
// a missing chime must never break the notification itself.
let audioCtx: AudioContext | null = null;

type AudioContextCtor = new () => AudioContext;

function context(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor =
    (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).AudioContext ??
    (window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    return null;
  }
  return audioCtx;
}

/** One soft sine ping, eased in and out so it reads as a chime and not a click. */
function ping(ctx: AudioContext, dest: AudioNode, freq: number, at: number, dur: number, gain: number): void {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(0, at);
  amp.gain.linearRampToValueAtTime(gain, at + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(amp);
  amp.connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** The followers / lobby-invite chime: a rising two-note "ding-dong". */
export function playFriendNotifySound(): void {
  const ctx = context();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.085;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.02;
    ping(ctx, master, 659.25, t0, 0.34, 0.9);        // E5
    ping(ctx, master, 987.77, t0 + 0.11, 0.5, 0.8);  // B5
  } catch {
    /* audio unavailable — the notification still shows */
  }
}
