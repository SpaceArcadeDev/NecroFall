// NECROFALL — coarse player region for matchmaking (hybrid architecture, 2026-09-29).
//
// Official gameplay is peer-to-peer, so the only thing a "region" buys is a
// short DIRECT hop: pairing same-region players first keeps WebRTC latency at
// LAN-ish levels. The tag is derived from the device timezone — no geolocation
// prompt, no backend call, works in dev and in the packaged game alike.
//
// Server side (`matchmaking/queue.ts`) treats the tag as a PREFERENCE: same
// region fills first, and after a short wait the lock relaxes so a thin region
// still finds matches. '' means "unknown" and is compatible with everything.
export function regionTag(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    if (!tz) return '';
    if (tz.startsWith('Asia/')) return 'as';
    if (tz.startsWith('Europe/') || tz.startsWith('Atlantic/') || tz.startsWith('Indian/')) return 'eu';
    if (tz.startsWith('Australia/') || tz.startsWith('Pacific/')) return 'oc';
    if (tz.startsWith('Africa/')) return 'af';
    if (tz.startsWith('America/')) {
      // Latin America is its own bucket (distances inside the Americas are continent-sized).
      return /Sao_Paulo|Argentina|Bogota|Lima|Santiago|Caracas|Montevideo|Asuncion|Guayaquil|Havana|Panama|Costa_Rica|La_Paz|Campo_Grande|Cuiaba|Bahia|Fortaleza|Recife|Maceio|Belem|Manaus|Porto_Velho|Rio_Branco|Boa_Vista|Santarem|Araguaina|Noronha|Eirunepe|Cayenne|Paramaribo|Punta_Arenas|Galapagos|Easter/.test(tz)
        ? 'sa'
        : 'na';
    }
    return '';
  } catch {
    return '';
  }
}
