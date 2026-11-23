import { describe, expect, it } from 'vitest'
import { cleanUrl, scrubCrumb, scrubEvent } from './monitoring'

describe('error reports', () => {
  it('never carry a query, an emailed link’s token or a share link’s secret', () => {
    expect(cleanUrl('https://reroute.example/reset-password#token=abc')).toBe('https://reroute.example/reset-password')
    expect(cleanUrl('https://reroute.example/v1/places?q=aunt')).toBe('https://reroute.example/v1/places')
    expect(cleanUrl('https://reroute.example/shared/SECRET/x')).toBe('https://reroute.example/shared/***/x')
    expect(cleanUrl('/v1/shared/SECRET')).toBe('/v1/shared/***')
  })

  it('keep only the page of a request, and nobody’s identity', () => {
    const event = scrubEvent({
      type: undefined,
      request: { url: 'https://reroute.example/me?x=1', headers: { Cookie: 'c' }, query_string: 'x=1' },
      user: { email: 'asha@example.com' },
    })
    expect(event.request).toEqual({ url: 'https://reroute.example/me' })
    expect(event.user).toBeUndefined()
  })

  it('drop what was typed or logged, and clean the addresses of the rest', () => {
    expect(scrubCrumb({ category: 'console', message: 'token abc' })).toBeNull()
    expect(scrubCrumb({ category: 'ui.input' })).toBeNull()
    expect(scrubCrumb({ category: 'fetch', data: { url: '/v1/places?q=aunt', method: 'GET' } })?.data).toEqual({ url: '/v1/places', method: 'GET' })
    expect(scrubCrumb({ category: 'navigation', data: { from: '/reset-password#token=a', to: '/signin' } })?.data).toEqual({ from: '/reset-password', to: '/signin' })
  })
})
