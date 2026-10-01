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
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SectionPageLayout } from '@/components/layout/components/section-page-layout'
import { LoadingState } from '@/components/loading-state'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { getInkosStatus } from './api'
import { InkosAccess } from './components/inkos-access'
import { InkosGrants } from './components/inkos-grants'

export function Inkos() {
  const user = useAuthStore((state) => state.auth.user)
  const sessionId = useAuthStore((state) => state.auth.session?.sid)
  const { t } = useTranslation()
  if (!user || !sessionId) return <ErrorState title={t('Sign in to use Inkos')} />
  return <InkosSession key={`${user.id}:${sessionId}`} userId={user.id} sessionId={sessionId} root={user.role === ROLE.SUPER_ADMIN} />
}

function InkosSession(props: { userId: number; sessionId: string; root: boolean }) {
  const { t } = useTranslation()
  const status = useQuery({
    queryKey: ['inkos', props.userId, props.sessionId, 'status'],
    queryFn: ({ signal }) => getInkosStatus(signal),
    retry: false, staleTime: 0, gcTime: 0, refetchInterval: 15000,
    meta: { errorToast: false },
  })
  let content: ReactNode
  if (status.isPending) {
    content = <div role='status'><LoadingState message={t('Loading Inkos access...')} /></div>
  } else if (status.isError || status.data.user_id !== props.userId) {
    content = <ErrorState title={t('Unable to load Inkos access')} onRetry={() => void status.refetch()} />
  } else if (!status.data.enabled) {
    content = <EmptyState title={t('Inkos integration is disabled')} description={t('Ask your administrator to configure the Inkos integration.')} />
  } else if (!status.data.allowed) {
    content = <EmptyState title={t('Inkos access has not been granted')} description={t('All accounts, including root, need an explicit Inkos grant. Contact your administrator.')} />
  } else {
    content = <InkosAccess status={status.data} sessionId={props.sessionId} />
  }
  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Inkos')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button nativeButton={false} variant='outline' render={<a href='/inkos-source/' target='_blank' rel='noopener noreferrer' />}>{t('Inkos source code (AGPL)')}</Button>
        <Button type='button' variant='outline' disabled={status.isFetching} onClick={() => void status.refetch()}>{t('Refresh access')}</Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='flex min-w-0 flex-col gap-4'>
          <Alert>
            <AlertTitle>{t('Your workspace, your new-api balance')}</AlertTitle>
            <AlertDescription className='flex flex-col gap-2'>
              <p>{t('Inkos model usage is charged to your own new-api balance through your bound limited API key. There is no separate Inkos wallet.')}</p>
              <p>{t('Integrated workspaces have no external network access. Web research, external model URLs and proxies are unavailable in this initial version.')}</p>
              <p>{t('An access grant does not create a worker. An administrator must provision your isolated workspace before first use.')}</p>
            </AlertDescription>
          </Alert>
          {content}
          {props.root && <InkosGrants userId={props.userId} sessionId={props.sessionId} />}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
