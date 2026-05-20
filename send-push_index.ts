// Supabase Edge Function: send-push
// バックグラウンドでWeb Push通知を送信する

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || ''
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || ''
const VAPID_SUBJECT = 'mailto:admin@wakecheck.app'

// Base64url デコード
function base64urlToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - base64url.length % 4) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)))
}

// VAPID JWT生成
async function generateVapidJWT(audience: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: VAPID_SUBJECT
  }

  const enc = new TextEncoder()
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const sigInput = enc.encode(`${headerB64}.${payloadB64}`)

  // 秘密鍵をインポート
  const privKeyBytes = base64urlToUint8Array(VAPID_PRIVATE_KEY)
  const cryptoKey = await crypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  )

  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey, sigInput
  )
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  return `${headerB64}.${payloadB64}.${sigB64}`
}

// Web Push送信
async function sendWebPush(subscription: {
  endpoint: string
  p256dh: string
  auth: string
}, payload: object): Promise<boolean> {
  try {
    const url = new URL(subscription.endpoint)
    const audience = `${url.protocol}//${url.host}`
    const jwt = await generateVapidJWT(audience)

    const body = JSON.stringify(payload)

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
        'Content-Type': 'application/json',
        'TTL': '86400',
      },
      body
    })

    console.log('Push送信結果:', res.status, subscription.endpoint.slice(0, 50))
    return res.ok
  } catch (e) {
    console.error('Push送信エラー:', e)
    return false
  }
}

Deno.serve(async (req) => {
  // CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { message_id, title, body, sender_name, to_user_id, tag } = await req.json()

    // to_user_id が指定された場合は直接そのユーザーにPush（返信通知・フォロー申請通知など）
    if (to_user_id && !message_id) {
      const { data: targetUser } = await supabase
        .from('users')
        .select('push_endpoint, push_p256dh, push_auth')
        .eq('id', to_user_id)
        .single()

      if (!targetUser?.push_endpoint) {
        return new Response(JSON.stringify({ error: 'no push subscription' }), { status: 200 })
      }

      const ok = await sendWebPush(
        { endpoint: targetUser.push_endpoint, p256dh: targetUser.push_p256dh, auth: targetUser.push_auth },
        { title: title || '🔔 WakeCheck', body: body || '通知があります', tag: tag || 'wc-notify', url: '/wakecheck/' }
      )
      return new Response(JSON.stringify({ success: ok }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    if (!message_id) {
      return new Response(JSON.stringify({ error: 'message_id or to_user_id required' }), { status: 400 })
    }

    // メッセージ情報取得
    const { data: msg } = await supabase
      .from('messages')
      .select('receiver_id, sender_id, body, alarm_min, status')
      .eq('id', message_id)
      .single()

    if (!msg) {
      return new Response(JSON.stringify({ error: 'message not found' }), { status: 404 })
    }

    // 受信者のPush購読情報を取得
    const { data: receiver } = await supabase
      .from('users')
      .select('name, push_endpoint, push_p256dh, push_auth')
      .eq('id', msg.receiver_id)
      .single()

    // 送信者のPush購読情報を取得（アラーム用）
    const { data: sender } = await supabase
      .from('users')
      .select('name, push_endpoint, push_p256dh, push_auth')
      .eq('id', msg.sender_id)
      .single()

    const results: string[] = []

    // 受信者に通知（新着メッセージ）
    if (receiver?.push_endpoint && msg.status === 'waiting') {
      const ok = await sendWebPush(
        { endpoint: receiver.push_endpoint, p256dh: receiver.push_p256dh, auth: receiver.push_auth },
        {
          title: title || `📩 ${sender?.name || ''}より確認メッセージ`,
          body: body || msg.body,
          tag: `recv-${message_id}`,
          url: '/wakecheck/'
        }
      )
      results.push(`receiver: ${ok ? 'ok' : 'failed'}`)
    }

    // 送信者にアラーム通知（未返信時）
    if (sender?.push_endpoint && msg.status === 'no_reply') {
      const ok = await sendWebPush(
        { endpoint: sender.push_endpoint, p256dh: sender.push_p256dh, auth: sender.push_auth },
        {
          title: `🚨 未返信アラーム`,
          body: `${receiver?.name || '相手'}さんが${msg.alarm_min}分以内に返信していません！`,
          tag: `alarm-${message_id}`,
          url: '/wakecheck/'
        }
      )
      results.push(`sender alarm: ${ok ? 'ok' : 'failed'}`)
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    })

  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
