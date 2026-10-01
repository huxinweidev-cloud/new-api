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
import type { InkosTicket, InkosToken } from '../types'

export function inkosStartUrl(origin: string): string | null {
  try {
    const url = new URL(origin)
    // Do not repair or normalize an untrusted configured origin.
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null
    return `${origin}/integration/start`
  } catch {
    return null
  }
}

export function isInkosTokenEligible(token: InkosToken): boolean {
  return token.remain_quota > 0 && token.model_limits_enabled &&
    token.model_limits.split(',').some((model) => model.trim().length > 0)
}

// Canonical unpadded base64url encoding of exactly 32 bytes.
export function isInkosNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)
}

export type InkosHandshakePhase = 'loading' | 'authorizing' | 'connecting' | 'ready'

type InkosHandshakeOptions = {
  origin: string
  frame: HTMLIFrameElement
  isCurrentSession: () => boolean
  requestTicket: (state: string, signal: AbortSignal) => Promise<InkosTicket>
  onPhase: (phase: InkosHandshakePhase) => void
  onError: (provisioningRequired: boolean) => void
}

/** A single preflight per frame; cancellation drops all late ticket replies. */
export function startInkosHandshake(options: InkosHandshakeOptions): () => void {
  const controller = new AbortController()
  let acceptedState: string | null = null
  let posted = false
  let loads = 0
  const timeout = window.setTimeout(() => fail(false), 60000)

  function fail(provisioningRequired: boolean) {
    if (controller.signal.aborted) return
    controller.abort()
    window.clearTimeout(timeout)
    options.onError(provisioningRequired)
  }

  function onLoad() {
    loads += 1
    // The first load is /integration/start, not an authenticated workspace.
    if (posted && loads >= 2 && options.isCurrentSession()) {
      window.clearTimeout(timeout)
      options.onPhase('ready')
    }
  }

  async function onMessage(event: MessageEvent<unknown>) {
    if (controller.signal.aborted || !options.isCurrentSession() ||
      !options.frame.contentWindow || event.origin !== options.origin || event.source !== options.frame.contentWindow) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.type === 'inkos-error' && posted && message.state === acceptedState) {
      fail(message.code === 'INKOS_WORKSPACE_NOT_PROVISIONED' || message.code === 'INKOS_WORKSPACE_UNAVAILABLE')
      return
    }
    if (message.type !== 'inkos-ready' || !isInkosNonce(message.state) || acceptedState !== null) return
    acceptedState = message.state
    options.onPhase('authorizing')
    const source = options.frame.contentWindow
    try {
      const result = await options.requestTicket(message.state, controller.signal)
      if (controller.signal.aborted || !options.isCurrentSession() ||
        source !== options.frame.contentWindow) return
      if (result.origin !== options.origin || !isInkosNonce(result.ticket) ||
        !Number.isFinite(result.expires_at) || result.expires_at * 1000 <= Date.now()) {
        fail(false)
        return
      }
      posted = true
      options.onPhase('connecting')
      source?.postMessage({ type: 'inkos-ticket', state: message.state, ticket: result.ticket }, options.origin)
    } catch {
      if (!controller.signal.aborted) fail(false)
    }
  }

  function onFrameError() { fail(false) }
  window.addEventListener('message', onMessage)
  options.frame.addEventListener('load', onLoad)
  options.frame.addEventListener('error', onFrameError)
  return () => {
    controller.abort()
    window.clearTimeout(timeout)
    window.removeEventListener('message', onMessage)
    options.frame.removeEventListener('load', onLoad)
    options.frame.removeEventListener('error', onFrameError)
  }
}
