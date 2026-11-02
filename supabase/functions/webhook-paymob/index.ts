import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_PREFIX_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null
}

/** Paymob's current docs stringify booleans as the words true/false. */
function literalValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

/** Older Accept samples were written in PHP, where true becomes "1" and false becomes "". */
function phpValue(value: unknown): string {
  if (value === true) return "1"
  if (value === false || value === null || value === undefined) return ""
  return String(value)
}

/**
 * Transaction Processed callback, in Paymob's required order.
 * https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac
 */
function concatenatedTransaction(obj: Record<string, unknown>, stringify: (value: unknown) => string): string {
  const order = asRecord(obj.order)
  const source = asRecord(obj.source_data)
  const orderId = order ? order.id : obj.order
  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    orderId,
    obj.owner,
    obj.pending,
    source?.pan,
    source?.sub_type,
    source?.type,
    obj.success,
  ]
  return fields.map(stringify).join("")
}

async function hmacSha512Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || left.length !== right.length) return false
  let mismatch = 0
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return mismatch === 0
}

async function isAuthenticPaymobRequest(obj: Record<string, unknown>, receivedHmac: string, secret: string): Promise<boolean> {
  const [literal, legacy] = await Promise.all([
    hmacSha512Hex(secret, concatenatedTransaction(obj, literalValue)),
    hmacSha512Hex(secret, concatenatedTransaction(obj, phpValue)),
  ])
  return timingSafeEqualHex(receivedHmac, literal) || timingSafeEqualHex(receivedHmac, legacy)
}

function isPaid(obj: Record<string, unknown>): boolean {
  const flag = (value: unknown) => value === true || value === "true"
  return flag(obj.success)
    && !flag(obj.pending)
    && !flag(obj.error_occured)
    && !flag(obj.is_voided)
    && !flag(obj.is_refunded)
}

function extractUserId(obj: Record<string, unknown>): string | null {
  const order = asRecord(obj.order)
  const claims = asRecord(obj.payment_key_claims)
  const extra = asRecord(claims?.extra) ?? asRecord(claims?.extras) ?? asRecord(obj.extras)
  const candidates = [
    order?.special_reference,
    obj.special_reference,
    order?.merchant_order_id,
    extra?.user_id,
    extra?.userId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    if (UUID_RE.test(candidate)) return candidate
    const leading = candidate.match(UUID_PREFIX_RE)
    if (leading) return leading[0]
  }
  return null
}

serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400)
  }

  const body = asRecord(payload)
  const obj = asRecord(body?.obj)
  if (!obj) return jsonResponse({ error: "Missing transaction object" }, 400)

  const secret = Deno.env.get("PAYMOB_HMAC")?.trim()
  if (!secret) {
    console.error("PAYMOB_HMAC is not set")
    return jsonResponse({ error: "Server misconfigured" }, 500)
  }

  const receivedHmac = new URL(req.url).searchParams.get("hmac") ?? ""
  const authentic = await isAuthenticPaymobRequest(obj, receivedHmac, secret)
  if (!authentic) return jsonResponse({ error: "Invalid HMAC" }, 401)

  if (!isPaid(obj)) return jsonResponse({ received: true })

  const userId = extractUserId(obj)
  if (!userId) {
    console.error("Paid Paymob callback is missing a user id", { transactionId: obj.id })
    return jsonResponse({ error: "Missing user id" }, 500)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (!supabaseUrl || !serviceKey) {
    console.error("Supabase service credentials are missing")
    return jsonResponse({ error: "Server misconfigured" }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const patch = {
    is_pro: true,
    plan_tier: "pro",
    updated_at: new Date().toISOString(),
  }

  try {
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", userId)
      .select("id")
    if (error) throw new Error(error.message)

    if (!data?.length) {
      const { error: insertError } = await supabase.from("profiles").insert({ id: userId, ...patch })
      if (insertError) throw new Error(insertError.message)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "profile update failed"
    console.error("Failed to upgrade profile", { userId, transactionId: obj.id, message })
    return jsonResponse({ error: "Profile update failed" }, 500)
  }

  return jsonResponse({ received: true })
})
