/**
 * Retry wrapper around a single Resend send call with exponential backoff
 * on rate-limit errors. Pure function (takes the send invocation as a
 * thunk) so it stays unit-testable without mocking the SDK.
 *
 * Treats any error whose message matches /rate|limit|429|too many/i, or
 * whose statusCode is 429, as retryable. Other errors throw immediately
 * — non-retryable failures (auth, payload, unknown sender) shouldn't burn
 * the backoff budget.
 */

type ResendError = { message?: string; statusCode?: number | null } | null
type ResendSendResult = { error: ResendError }

export interface ResendRetryOptions {
  label: string
  maxAttempts?: number
  initialDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withResendRetry(
  send: () => Promise<ResendSendResult>,
  opts: ResendRetryOptions
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 5
  const sleep = opts.sleep ?? defaultSleep
  let backoffMs = opts.initialDelayMs ?? 1000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await send()
    if (!error) return

    const msg = error.message ?? 'unknown error'
    const retryable = /rate|limit|429|too many/i.test(msg) || error.statusCode === 429

    if (!retryable || attempt === maxAttempts) {
      throw new Error(`Failed to ${opts.label}: ${msg}`)
    }

    console.log(
      `[${opts.label}] rate-limited (attempt ${attempt}/${maxAttempts}), waiting ${backoffMs}ms`
    )
    await sleep(backoffMs)
    backoffMs *= 2
  }
}
