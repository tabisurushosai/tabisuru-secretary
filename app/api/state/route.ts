import { NextResponse } from 'next/server';
import { getRedis, K } from '@/lib/redis';
import type { MacState, Alert, Command } from '@/lib/types';
import { adaptSecretaryState } from '@/lib/secretary_state_adapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const r = getRedis();
    const [macDirect, alerts, queue, pending] = await Promise.all([
      r.get<MacState>(K.macState),
      r.lrange<Alert>(K.alerts, 0, 49),
      r.lrange<string>(K.releaseQueue, 0, 49),
      r.lrange<Command>(K.commands, 0, 49),
    ]);

    // macState ('state:mac') が空なら secretary:state を読んで MacState 形に変換 (fallback)。
    // それでも取れなければ mac: null を返す (現状維持)。
    let mac: MacState | null = macDirect;
    if (!mac) {
      const secRaw = await r.get<unknown>(K.secretaryState);
      mac = adaptSecretaryState(secRaw);
    }
    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      mac,
      alerts: alerts ?? [],
      queue: queue ?? [],
      pending: pending ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
