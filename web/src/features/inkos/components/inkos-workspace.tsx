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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'

import { requestInkosTicket } from '../api'
import { inkosStartUrl, startInkosHandshake, type InkosHandshakePhase } from '../lib/handshake'

export function InkosWorkspace(props: { origin: string; userId: number; sessionId: string }) {
  const { t } = useTranslation()
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<InkosHandshakePhase>('loading')
  const [failure, setFailure] = useState<'connection' | 'provisioning' | null>(null)
  const startUrl = inkosStartUrl(props.origin)
  // The sandbox must never run on the dashboard's own origin.
  const src = props.origin === window.location.origin ? null : startUrl

  useEffect(() => {
    if (!src || !frame.current || failure) return
    return startInkosHandshake({
      frame: frame.current,
      origin: props.origin,
      isCurrentSession: () => {
        const auth = useAuthStore.getState().auth
        return auth.user?.id === props.userId && (auth.session?.sid ?? '') === props.sessionId
      },
      requestTicket: requestInkosTicket,
      onPhase: setPhase,
      onError: (provisioningRequired) => setFailure(provisioningRequired ? 'provisioning' : 'connection'),
    })
  }, [src, props.origin, props.userId, props.sessionId, attempt, failure])

  function retry() {
    setFailure(null)
    setPhase('loading')
    setAttempt((value) => value + 1)
  }

  if (!src) return <ErrorState title={t('Invalid Inkos origin configuration')} />
  if (failure) {
    return <ErrorState
      title={failure === 'provisioning' ? t('Workspace needs administrator provisioning') : t('Unable to open Inkos workspace')}
      description={t('Ask your administrator to check workspace provisioning, access and your bound API key.')}
      onRetry={retry}
    />
  }
  return (
    <section aria-label={t('Inkos workspace')} className='flex min-w-0 flex-col gap-2'>
      <div className='flex justify-end'>
        <Button type='button' variant='outline' size='sm' onClick={retry}>{t('Reconnect workspace')}</Button>
      </div>
      <div className='relative h-[70dvh] min-h-80 w-full overflow-hidden rounded-lg border sm:h-[75dvh]'>
        {/* Cross-origin broker needs its real origin for message checks and HttpOnly cookies.
            Same-origin origins are rejected above; neither scripts nor same-origin can be removed. */}
        <iframe
          key={attempt}
          ref={frame}
          title={t('Inkos workspace')}
          src={src}
          // oxlint-disable-next-line react/iframe-missing-sandbox -- Guarded cross-origin broker needs its origin and cookies.
          sandbox='allow-scripts allow-same-origin allow-forms allow-downloads'
          referrerPolicy='no-referrer'
          aria-hidden={phase !== 'ready'}
          tabIndex={phase === 'ready' ? 0 : -1}
          className='h-full w-full border-0'
        />
        {phase !== 'ready' && <div role='status' className='bg-background absolute inset-0 flex items-center justify-center'>
          <LoadingState message={t('Connecting to Inkos workspace...')} />
        </div>}
      </div>
    </section>
  )
}
