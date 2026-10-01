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

export const inkosStatusSchema = z.object({
  enabled: z.boolean(),
  allowed: z.boolean(),
  origin: z.string(),
  user_id: z.number().int().positive(),
  token_id: z.number().int().nonnegative(),
})
export const inkosTokenSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  remain_quota: z.number().finite(),
  model_limits_enabled: z.boolean(),
  model_limits: z.string(),
})
export const inkosGrantSchema = z.object({
  user_id: z.number().int().positive(),
  allowed: z.boolean(),
  token_id: z.number().int().nonnegative(),
})
export const inkosTicketSchema = z.object({
  ticket: z.string(),
  expires_at: z.number().int().positive(),
  origin: z.string(),
})

export type InkosStatus = z.infer<typeof inkosStatusSchema>
export type InkosToken = z.infer<typeof inkosTokenSchema>
export type InkosGrant = z.infer<typeof inkosGrantSchema>
export type InkosTicket = z.infer<typeof inkosTicketSchema>
