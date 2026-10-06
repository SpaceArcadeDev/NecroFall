/**
 * NECROFALL — device tier (mobile plan §2/§71).
 *
 * ONE place that answers "how much render budget does this device get", using the numbers the
 * browser exposes at boot: logical cores, device memory (Chromium only), panel DPR and the
 * viewport size. The tier picks only STARTING values — the adaptive resolution ladder and the
 * heat watchdog own everything after the first measured frames, so a mid device that performs
 * like a flagship climbs back up on its own.
 *
 * The DPR cap follows the plan's ladder (`window.innerWidth`, CSS pixels):
 *
 *   width ≥ 1800  → min(dpr, 1.5)
 *   width ≥ 1200  → min(dpr, 1.4)
 *   otherwise     → min(dpr, 1.25)
 *
 * clamped once more by the tier ceiling (high 1.5 / mid 1.4 / low 1.25). Rendering at the
 * panel's raw devicePixelRatio is one of the biggest mobile GPU killers — a 1440×3200 @3x
 * framebuffer is ~12 M subpixels for a view that at arm's length is indistinguishable from
 * 1.25-1.5x. The CSS/UI resolution is never touched by this: text and HUD stay at device DPR.
 */

export type DeviceTierName = 'high' | 'mid' | 'low';

export interface DeviceTierInfo {
  tier: DeviceTierName;
  /** Mobile/tablet class device (UA). Desktop GPUs have no thermal/battery ceiling. */
  mobile: boolean;
  /** Primary input is touch — the resolution ladder behaves differently on phones. */
  touch: boolean;
  /** navigator.hardwareConcurrency (0 = unknown). */
  cores: number;
  /** navigator.deviceMemory in GB (0 = API unsupported, e.g. Safari/Firefox). */
  memoryGb: number;
  /** Panel devicePixelRatio at boot. */
  dpr: number;
  width: number;
  height: number;
}

/** Tier ceilings: the most the device may ever render at (plan §71 HIGH/MEDIUM/LOW). */
const TIER_DPR_CAP: Record<DeviceTierName, number> = { high: 1.5, mid: 1.4, low: 1.25 };

/** Desktop keeps its own 2x ceiling — the plan's mobile ladder targets thermals, not monitors. */
const DESKTOP_DPR_CAP = 2;

function tierOf(cores: number, memoryGb: number): DeviceTierName {
  // Unknown signals (Safari hides `deviceMemory`) must never force a downgrade: treat them as
  // a healthy midpoint and let the measured frame rate decide.
  if (cores > 0 && cores <= 4) return 'low';
  if (memoryGb > 0 && memoryGb <= 3) return 'low';
  if (cores >= 8 && (memoryGb === 0 || memoryGb >= 6)) return 'high';
  if (cores === 0 && memoryGb === 0) return 'mid';
  if (cores >= 8 || memoryGb >= 6) return 'mid';
  return 'mid';
}

function readInfo(): DeviceTierInfo {
  let dpr = 1;
  let width = 0;
  let height = 0;
  let cores = 0;
  let memoryGb = 0;
  let mobile = false;
  let touch = false;
  try {
    dpr = window.devicePixelRatio || 1;
    width = window.innerWidth || 0;
    height = window.innerHeight || 0;
  } catch {
    /* non-browser context (tests) — stay on the defaults */
  }
  try {
    cores = navigator.hardwareConcurrency || 0;
  } catch {
    /* ignore */
  }
  try {
    memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
  } catch {
    /* ignore */
  }
  try {
    mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  } catch {
    /* ignore */
  }
  return { tier: tierOf(cores, memoryGb), mobile, touch, cores, memoryGb, dpr, width, height };
}

class DeviceTierImpl {
  readonly info: DeviceTierInfo = readInfo();

  get name(): DeviceTierName {
    return this.info.tier;
  }

  get isMobile(): boolean {
    return this.info.mobile;
  }

  get isTouch(): boolean {
    return this.info.touch;
  }

  /**
   * The plan §2 width ladder × the §71 tier ceiling, in DPR units. Desktop (non-mobile)
   * devices keep their 2x allowance — the ladder exists for phone/tablet thermals.
   */
  dprCap(): number {
    const { width, dpr, tier, mobile } = this.info;
    const ladder = width >= 1800 ? 1.5 : width >= 1200 ? 1.4 : 1.25;
    const cap = mobile ? Math.min(ladder, TIER_DPR_CAP[tier]) : DESKTOP_DPR_CAP;
    return Math.max(1, Math.min(dpr, cap));
  }

  /** The folio Quality level to boot at (0 = highest). The watchdog can still move it. */
  initialQualityLevel(): 0 | 1 | 2 {
    if (!this.info.mobile) return this.info.tier === 'low' ? 1 : 0;
    return this.info.tier === 'low' ? 2 : 1;
  }

  /** One-line boot log so a device report can be read back without guessing (mobile plan §51). */
  describe(): string {
    const i = this.info;
    return `tier=${i.tier} mobile=${i.mobile} cores=${i.cores || '?'} mem=${i.memoryGb || '?'}GB dpr=${i.dpr} view=${i.width}x${i.height} cap=${this.dprCap()}`;
  }
}

export const DeviceTier = new DeviceTierImpl();
