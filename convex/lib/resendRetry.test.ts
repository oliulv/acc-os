import { describe, test, expect } from 'bun:test'
import { withResendRetry } from './resendRetry'

const noopSleep = async () => {}

describe('withResendRetry', () => {
  test('resolves on first successful send → send called once', async () => {
    let calls = 0
    const send = async () => {
      calls++
      return { error: null }
    }
    await withResendRetry(send, { label: 'send welcome', sleep: noopSleep })
    expect(calls).toBe(1)
  })

  test('retryable error then success → send called twice', async () => {
    let calls = 0
    const send = async () => {
      calls++
      if (calls === 1) return { error: { message: 'rate limit exceeded' } }
      return { error: null }
    }
    await withResendRetry(send, { label: 'send', sleep: noopSleep })
    expect(calls).toBe(2)
  })

  test('non-retryable error throws on first attempt; error includes label and original message', async () => {
    let calls = 0
    const send = async () => {
      calls++
      return { error: { message: 'invalid sender' } }
    }
    await expect(
      withResendRetry(send, { label: 'send welcome', sleep: noopSleep })
    ).rejects.toThrow('Failed to send welcome: invalid sender')
    expect(calls).toBe(1)
  })

  test('exhausted retries (always rate-limited) → throws after maxAttempts calls', async () => {
    let calls = 0
    const send = async () => {
      calls++
      return { error: { message: 'rate limit hit' } }
    }
    await expect(
      withResendRetry(send, {
        label: 'send digest',
        maxAttempts: 3,
        initialDelayMs: 1,
        sleep: noopSleep,
      })
    ).rejects.toThrow('Failed to send digest: rate limit hit')
    expect(calls).toBe(3)
  })

  test('statusCode 429 with no message text → treated as retryable', async () => {
    let calls = 0
    const send = async () => {
      calls++
      if (calls === 1) return { error: { statusCode: 429 } }
      return { error: null }
    }
    await withResendRetry(send, { label: 'send', sleep: noopSleep })
    expect(calls).toBe(2)
  })

  test('backoff doubles between retries: delays = [d, 2d, 4d, ...]', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => {
      delays.push(ms)
    }
    const send = async () => ({ error: { message: 'too many requests' } })
    await expect(
      withResendRetry(send, {
        label: 'send',
        maxAttempts: 4,
        initialDelayMs: 100,
        sleep,
      })
    ).rejects.toThrow()
    // 4 attempts → 3 sleeps before the final throw
    expect(delays).toEqual([100, 200, 400])
  })

  test('error.message undefined and statusCode not 429 → non-retryable, throws immediately', async () => {
    let calls = 0
    const send = async () => {
      calls++
      return { error: { statusCode: 500 } }
    }
    await expect(withResendRetry(send, { label: 'send', sleep: noopSleep })).rejects.toThrow(
      'Failed to send: unknown error'
    )
    expect(calls).toBe(1)
  })
})
