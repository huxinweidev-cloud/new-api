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
import { z } from 'zod'

import { api } from '@/lib/api'
import { createServerError, requireServerSuccess } from '@/lib/server-error-message'

import {
  inkosGrantSchema,
  inkosStatusSchema,
  inkosTicketSchema,
  inkosTokenSchema,
  type InkosTicket,
} from './types'

// Validate the JSON envelope before using its data. No key endpoints are used.
const envelopeSchema = z.object({ success: z.literal(true), data: z.unknown() })

export async function getInkosStatus(signal: AbortSignal) {
  const response = await api.get('/api/inkos/status', { signal, disableDuplicate: true })
  return inkosStatusSchema.parse(envelopeSchema.parse(requireServerSuccess(response.data)).data)
}
export async function getInkosTokens(signal: AbortSignal) {
  const response = await api.get('/api/inkos/tokens', { signal, disableDuplicate: true })
  return z.array(inkosTokenSchema).parse(envelopeSchema.parse(requireServerSuccess(response.data)).data)
}
export async function bindInkosToken(tokenId: number) {
  const response = await api.put('/api/inkos/token', { token_id: tokenId })
  envelopeSchema.parse(requireServerSuccess(response.data))
}
export async function getInkosGrants(signal: AbortSignal) {
  const response = await api.get('/api/inkos/grants', { signal, disableDuplicate: true })
  return z.array(inkosGrantSchema).parse(envelopeSchema.parse(requireServerSuccess(response.data)).data)
}
export async function updateInkosGrant(userId: number, allowed: boolean) {
  const response = await api.put(`/api/inkos/grants/${userId}`, { allowed })
  envelopeSchema.parse(requireServerSuccess(response.data))
}

// Direct ephemeral request: never put a ticket into Query/Mutation cache.
export async function requestInkosTicket(state: string, signal: AbortSignal): Promise<InkosTicket> {
  const response = await api.post('/api/inkos/ticket', { state }, {
    signal,
    singleUseAuthorization: true,
    skipErrorHandler: true,
  })
  if (response.data?.success !== true) {
    throw createServerError(response.data, 'Unable to open Inkos workspace')
  }
  return inkosTicketSchema.parse(envelopeSchema.parse(response.data).data)
}
