import { NextResponse } from 'next/server';
import { getRedis, K } from '@/lib/redis';
import type { MacState, Alert, Command } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const r = getRedis();
    const [mac, alerts, queue, pending] = await Promise.all([
      r.get<MacState>(K.macState),
      r.lrange<Alert>(K.alerts, 0, 49),
      r.lrange<string>(K.releaseQueue, 0, 49),
      r.lrange<Command>(K.commands, 0, 49),
    ]);
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
