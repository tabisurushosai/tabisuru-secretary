import { NextRequest, NextResponse } from 'next/server';
import { getRedis, K } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// シンプルなトークン認証 (HB_SHARED_TOKEN)
function verifyToken(req: NextRequest): boolean {
  const expected = process.env.HB_SHARED_TOKEN;
  if (!expected) return true; // 未設定なら通す (dev)
  const got = req.headers.get('x-hb-token');
  return got === expected;
}

export async function POST(req: NextRequest) {
  if (!verifyToken(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const r = getRedis();

    // どこからのハートビートか
    if (body?.who) {
      await r.set(K.heartbeat(body.who), Date.now(), { ex: 600 });
    }

    // Mac 秘書からの全状態 push
    if (body?.mac_state) {
      await r.set(K.macState, body.mac_state);
    }

    // アラート追加
    if (body?.alerts && Array.isArray(body.alerts)) {
      for (const a of body.alerts) {
        await r.lpush(K.alerts, a);
      }
      await r.ltrim(K.alerts, 0, 199);
    }

    return NextResponse.json({ ok: true, ts: Date.now() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
