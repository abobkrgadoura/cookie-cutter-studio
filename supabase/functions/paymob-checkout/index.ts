import { serve } from "https://deno.land/std@0.224.0/http/server.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Paymob Intention API requires `state` in addition to the other billing fields.
const BILLING_DATA = {
  first_name: "Cutter",
  last_name: "User",
  email: "test@cutterstudio.com",
  phone_number: "+201000000000",
  country: "EG",
  city: "Cairo",
  state: "Cairo",
  street: "NA",
  building: "NA",
  floor: "NA",
  apartment: "NA",
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

/** Subject of the gateway-verified user access token. The anon key has no sub. */
function jwtSubject(req: Request): string | null {
  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  const payload = token?.split(".")[1]
  if (!payload) return null
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/")
    const json = JSON.parse(atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=")))
    return typeof json.sub === "string" ? json.sub : null
  } catch {
    return null
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405)

  try {
    const { amount_cents, currency, userId } = await req.json()
    const amount = typeof amount_cents === "string" ? Number(amount_cents) : amount_cents
    if (currency !== "EGP") return jsonResponse({ error: "currency must be EGP" }, 400)
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return jsonResponse({ error: "amount_cents must be a positive integer" }, 400)
    }
    if (typeof userId !== "string" || !UUID_RE.test(userId)) {
      return jsonResponse({ error: "userId must be the signed-in user's uuid" }, 400)
    }
    if (jwtSubject(req) !== userId) {
      return jsonResponse({ error: "userId does not match the signed-in user" }, 403)
    }

    const secretKey = Deno.env.get("PAYMOB_SECRET_KEY")?.trim()
    const publicKey = Deno.env.get("VITE_PAYMOB_PUBLIC_KEY")?.trim()
    if (!secretKey) return jsonResponse({ error: "PAYMOB_SECRET_KEY is not set" }, 500)
    if (!publicKey) return jsonResponse({ error: "VITE_PAYMOB_PUBLIC_KEY is not set" }, 500)

    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "")
    const notificationUrl = supabaseUrl
      ? `${supabaseUrl}/functions/v1/webhook-paymob`
      : undefined

    const paymobResponse = await fetch("https://accept.paymob.com/v1/intention/", {
      method: "POST",
      headers: {
        Authorization: `Token ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "EGP",
        payment_methods: [5964901], // The integration ID from .env
        items: [],
        billing_data: BILLING_DATA,
        // Paymob echoes special_reference as order.merchant_order_id and rejects a reuse.
        // The user id is the prefix; the suffix makes each attempt unique.
        special_reference: `${userId}:${crypto.randomUUID()}`,
        extras: { user_id: userId },
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
      }),
    })

    const paymobData = await paymobResponse.json().catch(() => ({}))
    const clientSecret = paymobData?.client_secret
    if (!paymobResponse.ok || typeof clientSecret !== "string" || !clientSecret) {
      const detail = paymobData?.detail || paymobData?.message || paymobResponse.statusText
      const message = typeof detail === "string" ? detail : JSON.stringify(paymobData)
      return jsonResponse({ error: message || "Paymob intention failed" }, 502)
    }

    const checkoutUrl =
      `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(publicKey)}` +
      `&clientSecret=${encodeURIComponent(clientSecret)}`

    return jsonResponse({ checkoutUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initialize checkout"
    console.error(message)
    return jsonResponse({ error: message }, 500)
  }
})
