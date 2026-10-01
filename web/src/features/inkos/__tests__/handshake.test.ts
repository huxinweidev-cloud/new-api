/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { inkosStartUrl, isInkosNonce, isInkosTokenEligible, startInkosHandshake } from '../lib/handshake'
import type { InkosTicket } from '../types'

const origin = 'https://inkos.example.test'
const state = 'A'.repeat(43)
const ticket = 'B'.repeat(42) + 'A'
let frame: HTMLIFrameElement
let stop: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  frame = document.createElement('iframe')
  document.body.append(frame)
})
afterEach(() => {
  stop?.()
  stop = undefined
  frame.remove()
  vi.useRealTimers()
})

function setup(result: Partial<InkosTicket> = {}) {
  const requestTicket = vi.fn<(state: string, signal: AbortSignal) => Promise<InkosTicket>>(async () => ({ ticket, origin, expires_at: Math.floor(Date.now() / 1000) + 60, ...result }))
  const onPhase = vi.fn()
  const onError = vi.fn()
  const isCurrentSession = vi.fn(() => true)
  stop = startInkosHandshake({ frame, origin, requestTicket, onPhase, onError, isCurrentSession })
  const source = frame.contentWindow
  if (!source) throw new Error('Missing frame window')
  const postMessage = vi.spyOn(source, 'postMessage')
  return { requestTicket, onPhase, onError, isCurrentSession, postMessage }
}
function send(data: unknown, senderOrigin = origin, source: MessageEventSource | null = frame.contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { origin: senderOrigin, source, data }))
}

it('valid ready from the exact frame requests one ticket and posts only ticket/state to its exact origin', async () => {
  const checks = setup()
  frame.dispatchEvent(new Event('load'))
  expect(checks.onPhase).not.toHaveBeenCalledWith('ready')
  send({ type: 'inkos-ready', state })
  await vi.waitFor(() => expect(checks.postMessage).toHaveBeenCalledWith({ type: 'inkos-ticket', state, ticket }, origin))
  expect(checks.requestTicket).toHaveBeenCalledWith(state, expect.any(AbortSignal))
  send({ type: 'inkos-ready', state })
  expect(checks.requestTicket).toHaveBeenCalledOnce()
  expect(checks.onPhase).toHaveBeenCalledWith('connecting')
  expect(checks.onPhase).not.toHaveBeenCalledWith('ready')
  frame.dispatchEvent(new Event('load'))
  expect(checks.onPhase).toHaveBeenCalledWith('ready')
})

it.each([
  ['sibling origin', { type: 'inkos-ready', state }, 'https://other.example.test', false],
  ['suffix origin', { type: 'inkos-ready', state }, origin + '.attacker.test', false],
  ['other source', { type: 'inkos-ready', state }, origin, true],
  ['wrong type', { type: 'ready', state }, origin, false],
  ['short state', { type: 'inkos-ready', state: 'A'.repeat(42) }, origin, false],
  ['padded state', { type: 'inkos-ready', state: state + '=' }, origin, false],
  ['noncanonical bits', { type: 'inkos-ready', state: 'A'.repeat(42) + 'B' }, origin, false],
  ['nonobject data', state, origin, false],
])('invalid ready (%s) cannot mint or post a ticket', async (_label, data, senderOrigin, foreignSource) => {
  const checks = setup()
  send(data, senderOrigin, foreignSource ? window : frame.contentWindow)
  await Promise.resolve()
  expect(checks.requestTicket).not.toHaveBeenCalled()
  expect(checks.postMessage).not.toHaveBeenCalled()
})

it.each([
  { origin: 'https://other.example.test' },
  { expires_at: Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000) },
  { ticket: 'invalid-ticket' },
])('invalid ticket response %j fails closed', async (result) => {
  const checks = setup(result)
  send({ type: 'inkos-ready', state })
  await vi.waitFor(() => expect(checks.onError).toHaveBeenCalledWith(false))
  expect(checks.postMessage).not.toHaveBeenCalled()
})

it('ticket API failure shows an error and cannot post credentials', async () => {
  const checks = setup()
  checks.requestTicket.mockRejectedValueOnce(new Error('Denied'))
  send({ type: 'inkos-ready', state })
  await vi.waitFor(() => expect(checks.onError).toHaveBeenCalledWith(false))
  expect(checks.postMessage).not.toHaveBeenCalled()
})

it.each(['cleanup', 'session switch'] as const)('%s while ticket is pending drops the late reply', async (reason) => {
  const checks = setup()
  let resolve: (value: InkosTicket) => void = () => undefined
  checks.requestTicket.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  send({ type: 'inkos-ready', state })
  if (reason === 'cleanup') stop?.()
  else checks.isCurrentSession.mockReturnValue(false)
  resolve({ ticket, origin, expires_at: Math.floor(Date.now() / 1000) + 60 })
  await Promise.resolve()
  await Promise.resolve()
  expect(checks.postMessage).not.toHaveBeenCalled()
  if (reason === 'cleanup') expect(checks.requestTicket.mock.calls[0]?.[1].aborted).toBe(true)
})

it('timeout aborts the pending authorization and reports a retryable error', async () => {
  const checks = setup()
  checks.requestTicket.mockImplementationOnce(() => new Promise(() => undefined))
  send({ type: 'inkos-ready', state })
  await vi.advanceTimersByTimeAsync(60000)
  expect(checks.onError).toHaveBeenCalledWith(false)
  expect(checks.requestTicket.mock.calls[0]?.[1].aborted).toBe(true)
  expect(checks.postMessage).not.toHaveBeenCalled()
})

it('matching broker provisioning error is distinct from a spoofed error', async () => {
  const checks = setup()
  send({ type: 'inkos-ready', state })
  await vi.waitFor(() => expect(checks.postMessage).toHaveBeenCalledOnce())
  send({ type: 'inkos-error', state, code: 'INKOS_WORKSPACE_NOT_PROVISIONED' }, origin, window)
  expect(checks.onError).not.toHaveBeenCalled()
  send({ type: 'inkos-error', state, code: 'INKOS_WORKSPACE_NOT_PROVISIONED' })
  expect(checks.onError).toHaveBeenCalledWith(true)
})

describe('origin and token eligibility', () => {
  it.each(['http://inkos.example.test', origin + '/', origin + '?key=x', origin + '/path', 'https://user:password@inkos.example.test', 'https://INKOS.example.test'])('configured origin %s is not normalized or repaired', (value) => {
    expect(inkosStartUrl(value)).toBeNull()
  })
  it('exact HTTPS origin yields a credential-free start URL', () => {
    expect(inkosStartUrl(origin)).toBe(origin + '/integration/start')
    expect(isInkosNonce(state)).toBe(true)
  })
  it.each([
    [0, true, 'model-a', false],
    [10, false, 'model-a', false],
    [10, true, ' , ', false],
    [10, true, 'model-a,model-b', true],
  ])('quota %s limits %s allowlist %s eligibility is %s', (quota, enabled, models, eligible) => {
    expect(isInkosTokenEligible({ id: 1, name: 'Writing', remain_quota: quota, model_limits_enabled: enabled, model_limits: models })).toBe(eligible)
  })
})
