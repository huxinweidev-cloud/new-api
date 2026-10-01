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
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field, FieldGroup } from '@/components/ui/field'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { TitledCard } from '@/components/ui/titled-card'
import { toIntlLocale } from '@/i18n/languages'
import { formatQuotaWithCurrency } from '@/lib/currency'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import { bindInkosToken } from '../api'
import { tokenBindingSchema, type TokenBindingForm } from '../lib/schemas'
import type { InkosToken } from '../types'

export function InkosTokenBinding(props: { tokens: InkosToken[]; tokenId: number; userId: number; sessionId: string; onBinding: () => void }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const client = useQueryClient()
  const form = useForm<TokenBindingForm>({ resolver: zodResolver(tokenBindingSchema), defaultValues: { token_id: props.tokenId } })
  useEffect(() => { form.reset({ token_id: props.tokenId }) }, [form, props.tokenId])
  const save = useMutation({
    mutationFn: async (values: TokenBindingForm) => {
      const auth = useAuthStore.getState().auth
      if (auth.user?.id !== props.userId || auth.session?.sid !== props.sessionId) throw new Error(t('Sign in to use Inkos'))
      if (!props.tokens.some((token) => token.id === values.token_id)) throw new Error(t('Select a limited API key'))
      props.onBinding()
      await bindInkosToken(values.token_id)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['inkos', props.userId, props.sessionId] })
      toast.success(t('Inkos API key binding saved'))
    },
    onError: (error) => {
      form.setError('root', { message: t('Unable to bind Inkos API key') })
      handleServerError(error, t('Unable to bind Inkos API key'))
    },
  })
  const selected = props.tokens.find((token) => token.id === form.watch('token_id'))
  return (
    <TitledCard title={t('Bound limited API key')} description={t('Only your own eligible keys are listed. Key values are never sent to Inkos.')} disableHoverEffect>
      <Form {...form}>
        <form onSubmit={form.handleSubmit((values) => save.mutate(values))}>
          <FieldGroup>
            <FormField control={form.control} name='token_id' render={({ field }) => (
              <FormItem>
                <Field data-invalid={!!form.formState.errors.token_id} data-disabled={save.isPending}>
                  <FormLabel>{t('Limited API key')}</FormLabel>
                  <FormControl>
                    <NativeSelect className='w-full' name={field.name} ref={field.ref} onBlur={field.onBlur} value={field.value} onChange={(event) => field.onChange(Number(event.target.value))} disabled={save.isPending}>
                      <NativeSelectOption value={0}>{t('Select a limited API key')}</NativeSelectOption>
                      {props.tokens.map((token) => <NativeSelectOption key={token.id} value={token.id}>{token.name} (#{token.id})</NativeSelectOption>)}
                    </NativeSelect>
                  </FormControl>
                  <FormDescription>{t('Remaining key quota')}: {formatQuotaWithCurrency(selected?.remain_quota, { locale })}</FormDescription>
                  <FormMessage />
                </Field>
              </FormItem>
            )} />
            {selected && <p className='text-muted-foreground break-words text-sm'>{t('Allowed models')}: {selected.model_limits}</p>}
            {form.formState.errors.root && <p role='alert' className='text-destructive text-sm'>{t('Unable to bind Inkos API key')}</p>}
            <Button type='submit' className='self-start' disabled={save.isPending || !selected || selected.id === props.tokenId}>{save.isPending ? t('Saving...') : t('Bind API key')}</Button>
          </FieldGroup>
        </form>
      </Form>
    </TitledCard>
  )
}
