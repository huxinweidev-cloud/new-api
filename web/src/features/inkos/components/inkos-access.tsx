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
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'

import { getInkosTokens } from '../api'
import { isInkosTokenEligible } from '../lib/handshake'
import type { InkosStatus } from '../types'
import { InkosTokenBinding } from './inkos-token-binding'
import { InkosWorkspace } from './inkos-workspace'

export function InkosAccess(props: { status: InkosStatus; sessionId: string }) {
  const { t } = useTranslation()
  const [opened, setOpened] = useState(false)
  const tokens = useQuery({
    queryKey: ['inkos', props.status.user_id, props.sessionId, 'tokens'],
    queryFn: ({ signal }) => getInkosTokens(signal),
    retry: false, staleTime: 0, gcTime: 0, refetchInterval: 15000,
    meta: { errorToast: false },
  })
  if (tokens.isPending) return <div role='status'><LoadingState message={t('Loading limited API keys...')} /></div>
  if (tokens.isError) return <ErrorState title={t('Unable to load limited API keys')} onRetry={() => void tokens.refetch()} />
  const eligible = tokens.data.filter(isInkosTokenEligible)
  if (!eligible.length) {
    return <EmptyState title={t('No eligible limited API keys')} description={t('Create an enabled, unexpired API key with a finite positive quota and a non-empty model allowlist, without an IP restriction.')} action={
      <Button nativeButton={false} variant='outline' render={<a href='/keys' />}>{t('Manage API keys')}</Button>
    } />
  }
  const bound = eligible.find((token) => token.id === props.status.token_id)
  return (
    <div className='flex min-w-0 flex-col gap-4'>
      <InkosTokenBinding tokens={eligible} tokenId={props.status.token_id} userId={props.status.user_id} sessionId={props.sessionId} onBinding={() => setOpened(false)} />
      {!bound && <EmptyState title={t('Bind a limited API key to continue')} />}
      {bound && !opened && <Button type='button' className='self-start' onClick={() => setOpened(true)}>{t('Open Inkos workspace')}</Button>}
      {bound && opened && <InkosWorkspace key={`${props.status.origin}:${bound.id}`} origin={props.status.origin} userId={props.status.user_id} sessionId={props.sessionId} />}
    </div>
  )
}
