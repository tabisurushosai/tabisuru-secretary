import { NextRequest, NextResponse } from 'next/server';
import { getRedis, K } from '@/lib/redis';
import type { Command } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_KINDS: Command['kind'][] = [
  'restart_loop',
  'rebuild_zip',
  'submit_one',
  'submit_all',
  'force_release',
  'rerun_butler',
  'pause_secretary',
  'resume_secretary',
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const kind = body?.kind as Command['kind'];
    const target = body?.target as string | undefined;

    if (!kind || !VALID_KINDS.includes(kind)) {
      return NextResponse.json(
        { error: `Invalid kind: ${kind}` },
        { status: 400 }
      );
    }

    const cmd: Command = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      kind,
      target,
      initiator: 'dashboard',
      status: 'pending',
    };

    const r = getRedis();
    await r.lpush(K.commands, JSON.stringify(cmd));
    // 古いものを切り詰め
    await r.ltrim(K.commands, 0, 99);

    return NextResponse.json({ ok: true, id: cmd.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
