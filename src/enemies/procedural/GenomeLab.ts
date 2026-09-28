// NECROFALL — ENEMY GENOME LAB (plan §40). Developer-only panel: generate a planet's
// bestiary from a seed and INSPECT it — body plan, limbs, organs, movement, targeting,
// attacks with their firing patterns, swarm formation, traits, ecology, ring.
// REGENERATE rolls a new seed, COPY SEED puts the exact seed on the clipboard.
//
// Open with `?enemyDebug=1`. Pure DOM — no THREE, no Game, no network.
import { factsFromSeed, generateEcology, type EcologyBestiary } from './EcologyGenerator';
import { genomeSignatures } from './SeedQa';
import type { EnemyGenome } from '../EnemyGenomes';
import { TARGET_BLURB } from './TargetGrammar';
import { FORMATION_BLURB } from './SwarmGrammar';
import { TRAIT_BLURB } from '../EnemyGenomes';

const RING_NAMES = ['BRONZE', 'SILVER', 'GOLD', 'DIAMOND', 'PLATINUM', 'LIBERATOR', 'GOD', 'KING OF GODS'];

let root: HTMLElement | null = null;
let seed = (Date.now() % 900000) + 1000;
let ring = 2;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function bodySummary(g: EnemyGenome): string {
  const v = g.visual;
  const parts: string[] = [];
  parts.push(`${v.legPairs}×legs`);
  if (v.plates > 1) parts.push(`${v.plates} plates`);
  if (v.spikes) parts.push(`${v.spikes} spikes`);
  if (v.horns) parts.push(`${v.horns} horns`);
  if (v.mandibles) parts.push(`${v.mandibles} mandibles`);
  if (v.tubes) parts.push(`${v.tubes} tubes`);
  if (v.glowNodes) parts.push(`${v.glowNodes} sacs`);
  if (v.wings) parts.push(`${v.wings} wings`);
  if (v.fins) parts.push(`${v.fins} fins`);
  if (v.sacs) parts.push(`${v.sacs} reservoirs`);
  if (v.segments > 1) parts.push(`${v.segments} segments`);
  if (v.tail) parts.push('tail');
  return parts.join(' · ');
}

function card(g: EnemyGenome, sig: ReturnType<typeof genomeSignatures>): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'border:1px solid rgba(150,140,200,0.25);border-radius:10px;padding:10px 12px;background:rgba(18,12,32,0.75);';
  const head = document.createElement('div');
  head.style.cssText = `font-weight:700;font-size:13px;letter-spacing:0.4px;color:${hex(g.accent)}`;
  head.textContent = `#${g.idx} ${g.name} — ${g.role ?? '?'} / ${g.tier}`;
  el.appendChild(head);

  const rows: [string, string][] = [
    ['Movement', `${g.locomotion ?? '?'} · gait ${g.gait?.style ?? '?'}${g.swarm ? ` · formation ${g.swarm.formation} (${FORMATION_BLURB[g.swarm.formation]})` : ''}`],
    ['Body', bodySummary(g)],
    ['Attacks', (g.attacks ?? []).map((a) => `${a.name} [${a.ability}/${a.pattern}]`).join(', ') || g.abilities.join(', ')],
    ['Passives', g.abilities.filter((a) => !(g.attacks ?? []).some((at) => at.ability === a)).join(', ') || '—'],
    ['Traits', g.traits.map((t) => `${t.toUpperCase()} (${TRAIT_BLURB[t]})`).join(' · ')],
    ['Targeting', `${g.targetPreference ?? 'NEAREST'} — ${TARGET_BLURB[g.targetPreference ?? 'NEAREST']}`],
    ['Armour', `${(g.armor ?? 1).toFixed(2)}× incoming`],
    ['Stats', `hp ${g.hp} · dmg ${g.damage} · spd ${g.speed.toFixed(1)} · range ${g.attackRange.toFixed(1)}`],
    ['Signature', `body ${sig.body.slice(0, 44)}…`],
  ];
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    r.style.cssText = 'font-size:11.5px;margin-top:3px;color:rgba(225,220,245,0.9);line-height:1.35;';
    r.innerHTML = `<span style="color:rgba(160,150,210,0.9);font-weight:600">${k}:</span> ${v}`;
    el.appendChild(r);
  }
  return el;
}

function render(): void {
  if (!root) return;
  root.innerHTML = '';
  const bestiary: EcologyBestiary = generateEcology(seed, factsFromSeed(seed, ring));

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;';
  bar.innerHTML = `
    <b style="letter-spacing:1px">ENEMY GENOME LAB</b>
    <label style="font-size:11px">SEED <input id="nfLabSeed" type="number" value="${seed}" style="width:110px;background:#1a1330;color:#eee;border:1px solid #463a7a;border-radius:6px;padding:3px 6px;" /></label>
    <label style="font-size:11px">RING <select id="nfLabRing" style="background:#1a1330;color:#eee;border:1px solid #463a7a;border-radius:6px;padding:3px 6px;">
      ${RING_NAMES.map((n, i) => `<option value="${i}" ${i === ring ? 'selected' : ''}>${n}</option>`).join('')}
    </select></label>
    <button id="nfLabRoll" style="cursor:pointer">REGENERATE</button>
    <button id="nfLabCopy" style="cursor:pointer">COPY SEED</button>
    <span id="nfLabStats" style="font-size:11px;color:rgba(170,160,220,0.9)">${bestiary.genomes.length} genomes · ecology ${bestiary.ecologyKind}</span>
  `;
  root.appendChild(bar);
  const list = document.createElement('div');
  list.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px;';
  for (const g of bestiary.genomes) list.appendChild(card(g, genomeSignatures(g)));
  root.appendChild(list);

  const seedIn = root.querySelector<HTMLInputElement>('#nfLabSeed');
  seedIn?.addEventListener('change', () => {
    seed = Math.max(1, Math.floor(Number(seedIn.value) || 1));
    render();
  });
  const ringSel = root.querySelector<HTMLSelectElement>('#nfLabRing');
  ringSel?.addEventListener('change', () => {
    ring = Math.max(0, Math.min(7, Math.floor(Number(ringSel.value) || 0)));
    render();
  });
  root.querySelector('#nfLabRoll')?.addEventListener('click', () => {
    seed = Math.floor(Math.random() * 900000) + 1000;
    render();
  });
  root.querySelector('#nfLabCopy')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(String(seed));
  });
}

/** Opens the lab (idempotent). */
export function mountGenomeLab(): void {
  if (root) return;
  root = document.createElement('div');
  root.id = 'nf-genome-lab';
  root.style.cssText =
    'position:fixed;inset:24px auto 24px 24px;width:min(860px,calc(100vw - 48px));z-index:300;overflow:auto;' +
    'background:rgba(8,5,18,0.94);border:1px solid rgba(150,140,200,0.3);border-radius:14px;padding:14px;' +
    'font-family:Rajdhani,system-ui,sans-serif;color:#eee;';
  document.body.appendChild(root);
  render();
}

/** Toggles from the URL: `?enemyDebug=1` (plan §40). */
export function maybeMountGenomeLab(): void {
  if (typeof location === 'undefined') return;
  if (/[?&]enemyDebug=1/.test(location.search)) mountGenomeLab();
}
