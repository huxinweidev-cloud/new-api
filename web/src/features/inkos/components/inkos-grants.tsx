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
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { StaticDataTable } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup } from '@/components/ui/field'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { TitledCard } from '@/components/ui/titled-card'
import { handleServerError } from '@/lib/handle-server-error'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { getInkosGrants, updateInkosGrant } from '../api'
import { grantFormSchema, type GrantForm } from '../lib/schemas'

type GrantChange = { userId: number; allowed: boolean }

export function InkosGrants(props: { userId: number; sessionId: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [target, setTarget] = useState<GrantChange | null>(null)
  const grants = useQuery({
    queryKey: ['inkos', props.userId, props.sessionId, 'grants'],
    queryFn: ({ signal }) => getInkosGrants(signal),
    retry: false, staleTime: 0, gcTime: 0,
    meta: { errorToast: false },
  })
  const form = useForm<GrantForm>({ resolver: zodResolver(grantFormSchema), defaultValues: { user_id: '', allowed: true } })
  const save = useMutation({
    mutationFn: async (change: GrantChange) => {
      const auth = useAuthStore.getState().auth
      if (auth.user?.id !== props.userId || auth.user.role !== ROLE.SUPER_ADMIN || auth.session?.sid !== props.sessionId) throw new Error(t('Sign in to use Inkos'))
      await updateInkosGrant(change.userId, change.allowed)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['inkos', props.userId, props.sessionId] })
      setTarget(null)
      form.reset()
      toast.success(t('Inkos access grant saved'))
    },
    onError: (error) => handleServerError(error, t('Unable to update Inkos access')),
  })
  return (
    <TitledCard title={t('Inkos access management')} description={t('Root can grant or revoke access, but also needs an explicit grant to use Inkos. Worker provisioning remains a separate administrator task.')} disableHoverEffect>
      <div className='flex min-w-0 flex-col gap-4'>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => setTarget({ userId: Number(values.user_id), allowed: values.allowed }))}>
            <FieldGroup>
              <FormField control={form.control} name='user_id' render={({ field }) => (
                <FormItem>
                  <Field data-invalid={!!form.formState.errors.user_id} data-disabled={save.isPending}>
                    <FormLabel>{t('User ID')}</FormLabel>
                    <FormControl><Input {...field} inputMode='numeric' autoComplete='off' disabled={save.isPending} /></FormControl>
                    <FormMessage />
                  </Field>
                </FormItem>
              )} />
              <FormField control={form.control} name='allowed' render={({ field }) => (
                <FormItem>
                  <Field orientation='horizontal' data-disabled={save.isPending}>
                    <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} disabled={save.isPending} /></FormControl>
                    <FormLabel>{t('Allow Inkos access')}</FormLabel>
                    <FormMessage />
                  </Field>
                </FormItem>
              )} />
              <Button type='submit' className='self-start' disabled={save.isPending}>{t('Review access change')}</Button>
            </FieldGroup>
          </form>
        </Form>
        {grants.isPending && <div role='status'><LoadingState message={t('Loading Inkos grants...')} /></div>}
        {grants.isError && <ErrorState title={t('Unable to load Inkos grants')} onRetry={() => void grants.refetch()} />}
        {grants.isSuccess && <StaticDataTable
          tableProps={{ 'aria-label': t('Inkos access grants') }}
          data={grants.data}
          getRowKey={(grant) => grant.user_id}
          emptyContent={<EmptyState title={t('No explicit Inkos grants')} />}
          columns={[
            { id: 'user', header: t('User ID'), cell: (grant) => `#${grant.user_id}` },
            { id: 'allowed', header: t('Access'), cell: (grant) => <Badge variant={grant.allowed ? 'default' : 'secondary'}>{grant.allowed ? t('Allowed') : t('Denied')}</Badge> },
            { id: 'token', header: t('Bound limited API key'), cell: (grant) => grant.token_id ? `#${grant.token_id}` : t('Not bound') },
            { id: 'actions', header: t('Actions'), cell: (grant) => <Button type='button' variant={grant.allowed ? 'destructive' : 'outline'} size='sm' disabled={save.isPending} aria-label={t('Change Inkos access for user {{id}}', { id: grant.user_id })} onClick={() => setTarget({ userId: grant.user_id, allowed: !grant.allowed })}>{grant.allowed ? t('Revoke') : t('Allow')}</Button> },
          ]}
        />}
        <ConfirmDialog
          open={target !== null}
          onOpenChange={(open) => { if (!open && !save.isPending) setTarget(null) }}
          title={target?.allowed ? t('Grant Inkos access?') : t('Revoke Inkos access?')}
          desc={t('Change Inkos access for user {{id}}. Revocation ends workspace access; granting does not provision a worker.', { id: target?.userId })}
          confirmText={target?.allowed ? t('Allow') : t('Revoke')}
          destructive={!target?.allowed}
          isLoading={save.isPending}
          handleConfirm={() => { if (target) save.mutate(target) }}
        />
      </div>
    </TitledCard>
  )
}
