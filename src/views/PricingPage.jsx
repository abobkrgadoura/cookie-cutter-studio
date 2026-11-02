import { useEffect, useState } from 'react'
import { initializePaddle } from '@paddle/paddle-js'
import { ArrowLeft, Check, ChevronDown, Loader2, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/useAuth.js'
import { useSettings } from '../context/useSettings.js'
import { supabase } from '../lib/authClient.js'

const PADDLE_LOCAL_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

function paddleEnvironment(token) {
  if (token.startsWith('live_')) return 'production'
  if (import.meta.env.VITE_PADDLE_ENVIRONMENT === 'production') return 'production'
  return 'sandbox'
}

const PRO_FEATURES = [
  'Unlimited Cloud Library — save every cutter and reopen it on any device, with no storage cap.',
  'Custom Wall Text — engrave names, dates, and short messages into the cutter wall.',
  'Advanced Cutter Types — design Sablé linzers, stamps, and cutter-stamp combinations.',
  'Commercial License — sell the cookies you bake and the cutters you design.',
  'Advanced Export Settings — download print-ready STL, OBJ, and 3MF for your slicer.',
  'Priority Support — get a response first when a print deadline is close.',
]

export function PricingPage() {
  const { setView, image } = useSettings()
  const { user, openAuthModal } = useAuth()
  const [isAnnual, setIsAnnual] = useState(true)
  const [currency, setCurrency] = useState('USD')
  const [showFeatures, setShowFeatures] = useState(false)
  const [loading, setLoading] = useState(false)
  const [paddle, setPaddle] = useState(null)

  useEffect(() => {
    const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN?.trim()
    if (!token) {
      console.error('VITE_PADDLE_CLIENT_TOKEN is missing')
      return undefined
    }

    let cancelled = false
    initializePaddle({
      environment: paddleEnvironment(token),
      token,
      eventCallback(event) {
        if (event?.name !== 'checkout.error' && event?.name !== 'checkout.failed') return
        const detail = event.detail || event.code
        if (detail) toast.error(String(detail))
      },
    })
      .then((paddleInstance) => {
        if (!cancelled && paddleInstance) setPaddle(paddleInstance)
      })
      .catch((err) => {
        console.error(err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const isUsd = currency === 'USD'
  const monthlyAmount = isUsd ? 12.5 : 625
  const currentPrice = isAnnual ? (isUsd ? 9.99 : 499) : monthlyAmount
  const totalBilled = isAnnual ? (isUsd ? (9.99 * 12).toFixed(2) : 499 * 12) : monthlyAmount
  const priceText = isUsd ? `$${currentPrice.toFixed(2)}` : `${currentPrice}`
  const compareText = isUsd ? '$12.50' : '625'
  const currencyUnit = isUsd ? 'USD / month' : 'EGP / month'
  const billedLabel = isAnnual
    ? `Billed annually as ${isUsd ? `$${totalBilled}` : `${totalBilled} EGP`}`
    : `Billed monthly at ${isUsd ? `$${Number(totalBilled).toFixed(2)}` : `${totalBilled} EGP`}`

  const returnToDesigner = () => {
    setView(image ? 'editor' : 'landing')
  }

  const handleCheckout = async () => {
    if (!user) {
      toast('Please log in or create an account to upgrade.', { icon: '🔒' })
      openAuthModal()
      return
    }

    setLoading(true)
    try {
      if (currency === 'EGP') {
        if (!supabase) throw new Error('Supabase is not configured.')
        // Auth state is { email, provider, user }. The uuid is on the Supabase user.
        const userId = user.user?.id ?? user.id
        if (!userId) throw new Error('Your account is missing an id. Sign out and sign in again.')
        const payload = {
          amount_cents: isAnnual ? 598800 : 62500, // in piastres
          currency: 'EGP',
          plan_type: isAnnual ? 'annual' : 'monthly',
          userId,
        }
        const { data, error } = await supabase.functions.invoke('paymob-checkout', { body: payload })
        if (error) {
          let detail = error.message
          if (typeof error.context?.json === 'function') {
            const body = await error.context.json().catch(() => null)
            if (body?.error) detail = body.error
          }
          throw new Error(detail || 'Failed to initialize checkout.')
        }
        if (data?.checkoutUrl) window.location.href = data.checkoutUrl
        else throw new Error(data?.error || 'Invalid response')
      } else {
        if (!paddle) throw new Error('Paddle is still loading. Try again in a moment.')
        const origin = window.location.origin
        if (!PADDLE_LOCAL_ORIGINS.has(origin)) {
          throw new Error('Open http://localhost:5173 or http://127.0.0.1:5173 before starting sandbox checkout.')
        }
        const priceId = (isAnnual
          ? import.meta.env.VITE_PADDLE_ANNUAL_PRICE_ID
          : import.meta.env.VITE_PADDLE_MONTHLY_PRICE_ID
        )?.trim()
        if (!priceId?.startsWith('pri_')) throw new Error('Paddle price is not configured.')
        const email = user.email?.trim()
        paddle.Checkout.open({
          items: [{ priceId, quantity: 1 }],
          ...(email?.includes('@') ? { customer: { email } } : {}),
          customData: {
            plan_type: isAnnual ? 'annual' : 'monthly',
          },
          settings: {
            displayMode: 'overlay',
            theme: 'dark',
          },
        })
      }
    } catch (err) {
      console.error(err)
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to initialize checkout.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto bg-[var(--bg-app)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.22),transparent_68%)]" />
      <div className="relative mx-auto flex w-full max-w-5xl flex-col px-6 py-10 sm:py-14">
        <button
          type="button"
          onClick={returnToDesigner}
          className="mb-8 inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <ArrowLeft size={16} />
          Back to designer
        </button>

        <div className="mb-10 text-center">
          <p className="mb-3 text-[12px] font-semibold tracking-[0.18em] text-[var(--accent)]">
            CUTTER STUDIO PRO
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
            Choose your plan
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-[var(--text-secondary)]">
            Unlock unlimited cloud storage, custom cutters, and export tools built for production prints.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3">
            <div
              role="group"
              aria-label="Currency"
              className="inline-flex items-center rounded-full border border-white/10 bg-white/5 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md"
            >
              {['USD', 'EGP'].map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={currency === code}
                  onClick={() => setCurrency(code)}
                  className={`rounded-full px-4 py-1.5 text-[12px] font-semibold tracking-wide transition-all ${
                    currency === code
                      ? 'bg-white/15 text-white shadow-[0_0_18px_rgba(167,139,250,0.35)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>

            <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-black/40 p-1 backdrop-blur-md">
              <button
                type="button"
                aria-pressed={!isAnnual}
                onClick={() => setIsAnnual(false)}
                className={`rounded-full px-5 py-2 text-sm font-medium transition-all ${
                  !isAnnual
                    ? 'bg-[var(--surface-light)] text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                aria-pressed={isAnnual}
                onClick={() => setIsAnnual(true)}
                className={`rounded-full px-5 py-2 text-sm font-medium transition-all ${
                  isAnnual
                    ? 'bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                Annually
                <span className="ml-2 rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-green-400">
                  SAVE 20%
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="grid items-start gap-6 md:grid-cols-2">
          <section className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md sm:p-8">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">Starter</h2>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">
                {isUsd ? '$0' : '0'}
              </span>
              <span className="text-sm text-[var(--text-muted)]">{currency}</span>
            </div>
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              For trying a single silhouette and a basic handled cutter.
            </p>
            <button
              type="button"
              disabled
              className="mt-6 w-full rounded-md border border-[var(--border)] bg-[var(--surface-light)] py-3 text-sm font-semibold text-[var(--text-muted)]"
            >
              Current plan
            </button>
            <ul className="mt-6 space-y-3 text-sm text-[var(--text-secondary)]">
              <li className="flex items-center gap-3">
                <Check className="text-green-500" size={16} /> Standard cutter
              </li>
              <li className="flex items-center gap-3">
                <Check className="text-green-500" size={16} /> Basic size adjustments
              </li>
              <li className="flex items-center gap-3 text-[var(--text-muted)]">
                <span className="inline-block size-4 text-center leading-4">–</span>
                Cloud library, wall text, and advanced export stay on Pro
              </li>
            </ul>
          </section>

          <section className="relative flex flex-col rounded-2xl border border-violet-400/80 bg-gradient-to-b from-violet-500/15 to-white/[0.03] p-6 shadow-[0_0_0_1px_rgba(167,139,250,0.35),0_0_48px_rgba(139,92,246,0.28)] backdrop-blur-xl sm:p-8">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 px-3 py-1 text-[10px] font-bold tracking-wider text-white">
              MOST POPULAR
            </div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
              <Sparkles className="text-fuchsia-400" size={18} />
              Pro
            </h2>
            <div className="mt-4 flex items-baseline gap-2">
              {isAnnual && (
                <span className="text-lg text-[var(--text-muted)] line-through">{compareText}</span>
              )}
              <span className="text-5xl font-bold tracking-tight text-[var(--text-primary)]">{priceText}</span>
              <span className="text-sm text-[var(--text-muted)]">{currencyUnit}</span>
            </div>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{billedLabel}</p>

            <button
              type="button"
              onClick={handleCheckout}
              disabled={loading}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3 text-sm font-bold text-white shadow-lg transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-70"
            >
              {loading ? <Loader2 className="animate-spin" size={18} /> : 'Upgrade now'}
            </button>
            <p className="mt-2 text-center text-[11px] text-[var(--text-muted)]">
              {isUsd ? 'Global checkout via Paddle' : 'Local checkout via Paymob'}
            </p>

            <div className="mt-6 flex items-start gap-3 text-sm font-medium text-[var(--text-primary)]">
              <Check className="mt-0.5 shrink-0 text-fuchsia-400" size={16} />
              <span>Unlimited Cloud Storage & Advanced Cutters</span>
            </div>

            <button
              type="button"
              onClick={() => setShowFeatures(!showFeatures)}
              aria-expanded={showFeatures}
              aria-controls="pro-feature-list"
              className="mt-4 inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              View all features
              <ChevronDown
                size={16}
                className={`transition-transform duration-300 ${showFeatures ? 'rotate-180' : ''}`}
              />
            </button>

            <div
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
                showFeatures ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <ul id="pro-feature-list" aria-hidden={!showFeatures} className="overflow-hidden">
                {PRO_FEATURES.map((feature) => (
                  <li
                    key={feature}
                    className="flex gap-3 border-t border-[var(--border)] py-3 text-sm leading-relaxed text-[var(--text-secondary)] first:mt-3"
                  >
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-fuchsia-400" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
