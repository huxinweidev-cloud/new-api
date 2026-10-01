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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, type AxiosAdapter } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useSidebarData } from '@/hooks/use-sidebar-data'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { Inkos } from '..'
import { InkosWorkspace } from '../components/inkos-workspace'

const origin = 'https://inkos.example.test'
const state = 'A'.repeat(43)
const ticket = 'B'.repeat(42) + 'A'
const status = { enabled: true, allowed: true, origin, user_id: 1, token_id: 7 }
const token = { id: 7, name: 'Writing', remain_quota: 500000, model_limits_enabled: true, model_limits: 'writing-model' }
const originalAdapter = api.defaults.adapter
let client: QueryClient
let responses: Record<string, unknown>
let adapter: ReturnType<typeof vi.fn<AxiosAdapter>>

function login(id = 1, role = 1, sid = 'dashboard-session') {
  useAuthStore.getState().auth.setBundle({
    access_token: 'test-only-dashboard-bearer', token_type: 'Bearer', access_expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id, username: `user-${id}`, role },
    session: { sid, current: true, login_method: 'password', ip: '', user_agent: '', created_at: 1, last_active_at: 1, expires_at: Math.floor(Date.now() / 1000) + 3600 },
  })
}
function mount() {
  return render(<QueryClientProvider client={client}><Inkos /></QueryClientProvider>)
}
function SidebarEntry() {
  const items = useSidebarData().navGroups.flatMap((group) => group.items)
  return <>{items.filter((item) => 'url' in item && item.url === '/inkos').map((item) => <a key={item.title} href={'url' in item ? item.url : undefined}>{item.title}</a>)}</>
}
beforeEach(() => {
  login()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  responses = { '/api/inkos/status': status, '/api/inkos/tokens': [token], '/api/inkos/grants': [] }
  adapter = vi.fn<AxiosAdapter>(async (config) => ({ data: { success: true, data: responses[config.url ?? ''] ?? null }, status: 200, statusText: 'OK', headers: {}, config }))
  api.defaults.adapter = adapter
})
afterEach(() => {
  client.clear()
  api.defaults.adapter = originalAdapter
  useAuthStore.getState().auth.reset()
})

it('loading access preserves notices, source link and the scrollable page without mounting a frame', async () => {
  adapter.mockImplementationOnce(() => new Promise(() => undefined))
  mount()
  expect(screen.getByRole('status')).toHaveTextContent('Loading Inkos access...')
  expect(screen.getByRole('link', { name: 'Inkos source code (AGPL)' })).toHaveAttribute('href', '/inkos-source/')
  expect(screen.getByText(/There is no separate Inkos wallet/)).toBeVisible()
  expect(screen.getByText(/no external network access/)).toBeVisible()
  expect(screen.getByText(/does not create a worker/)).toBeVisible()
  expect(screen.getByRole('main')).toHaveClass('min-h-0', 'overflow-hidden')
  expect(screen.getByRole('main').querySelector('.overflow-auto')).not.toBeNull()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('status API failure shows retry and retry resolves the denied empty state', async () => {
  adapter.mockRejectedValueOnce(new Error('Network unavailable'))
  responses['/api/inkos/status'] = { ...status, allowed: false }
  mount()
  expect(await screen.findByText('Unable to load Inkos access')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Inkos access has not been granted')).toBeVisible()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('root without a grant sees management but cannot use the workspace', async () => {
  login(1, 100)
  responses['/api/inkos/status'] = { ...status, allowed: false }
  mount()
  expect(await screen.findByText('Inkos access has not been granted')).toBeVisible()
  expect(await screen.findByText('No explicit Inkos grants')).toBeVisible()
  expect(screen.getByLabelText('User ID')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Open Inkos workspace' })).not.toBeInTheDocument()
  expect(adapter.mock.calls.some(([config]) => config.url === '/api/inkos/tokens')).toBe(false)
})

it('ordinary denied accounts never request root grant management', async () => {
  responses['/api/inkos/status'] = { ...status, allowed: false }
  mount()
  expect(await screen.findByText('Inkos access has not been granted')).toBeVisible()
  expect(screen.queryByText('Inkos access management')).not.toBeInTheDocument()
  expect(adapter.mock.calls.some(([config]) => config.url === '/api/inkos/grants')).toBe(false)
})

it.each([
  ['disabled integration', { ...status, enabled: false }, [token], 'Inkos integration is disabled'],
  ['no eligible key', status, [], 'No eligible limited API keys'],
  ['missing model limits', status, [{ ...token, model_limits_enabled: false }], 'No eligible limited API keys'],
  ['bound key not eligible', { ...status, token_id: 99 }, [token], 'Bind a limited API key to continue'],
])('%s blocks mounting Inkos and shows the expected empty state', async (_label, access, tokens, title) => {
  responses['/api/inkos/status'] = access
  responses['/api/inkos/tokens'] = tokens
  mount()
  expect(await screen.findByText(title)).toBeVisible()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('token list failure has a retryable state without the workspace', async () => {
  adapter.mockImplementation(async (config) => {
    if (config.url === '/api/inkos/tokens') throw new Error('No token list')
    return { data: { success: true, data: status }, status: 200, statusText: 'OK', headers: {}, config }
  })
  mount()
  expect(await screen.findByText('Unable to load limited API keys')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('eligible key opens a bounded frame, keeps it unfocusable during handshake and reconnect replaces it', async () => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Open Inkos workspace' }))
  const frame = screen.getByTitle('Inkos workspace')
  expect(frame).toHaveAttribute('src', origin + '/integration/start')
  expect(frame).toHaveAttribute('tabindex', '-1')
  expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
  expect(frame.parentElement).toHaveClass('min-h-80', 'overflow-hidden', 'w-full')
  expect(screen.getByRole('status')).toHaveTextContent('Connecting to Inkos workspace...')
  await userEvent.click(screen.getByRole('button', { name: 'Reconnect workspace' }))
  expect(screen.getByTitle('Inkos workspace')).not.toBe(frame)
})

it('a failed ticket removes the frame and retry mounts a fresh preflight', async () => {
  responses['/api/inkos/ticket'] = undefined
  adapter.mockImplementation(async (config) => ({ data: config.url === '/api/inkos/ticket' ? { success: false, message: 'Denied' } : { success: true, data: responses[config.url ?? ''] }, status: 200, statusText: 'OK', headers: {}, config }))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Open Inkos workspace' }))
  const frame = screen.getByTitle('Inkos workspace') as HTMLIFrameElement
  act(() => window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'inkos-ready', state } })))
  expect(await screen.findByText('Unable to open Inkos workspace')).toBeVisible()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.getByTitle('Inkos workspace')).not.toBe(frame)
})

it.each(['logout', 'account switch', 'session switch'] as const)('%s unmounts the active frame and cannot reuse the previous view', async (change) => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Open Inkos workspace' }))
  const frame = screen.getByTitle('Inkos workspace')
  responses['/api/inkos/status'] = { ...status, user_id: 2, allowed: false }
  act(() => {
    if (change === 'logout') useAuthStore.getState().auth.reset()
    else if (change === 'account switch') login(2)
    else login(1, 1, 'another-session')
  })
  expect(frame).not.toBeInTheDocument()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('refresh after grant revocation immediately removes the mounted frame', async () => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Open Inkos workspace' }))
  responses['/api/inkos/status'] = { ...status, allowed: false }
  await userEvent.click(screen.getByRole('button', { name: 'Refresh access' }))
  expect(await screen.findByText('Inkos access has not been granted')).toBeVisible()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('ready removes the loading overlay only after the authenticated frame navigation', async () => {
  responses['/api/inkos/ticket'] = { ticket, origin, expires_at: Math.floor(Date.now() / 1000) + 60 }
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Open Inkos workspace' }))
  const frame = screen.getByTitle('Inkos workspace') as HTMLIFrameElement
  fireEvent.load(frame)
  act(() => window.dispatchEvent(new MessageEvent('message', { origin, source: frame.contentWindow, data: { type: 'inkos-ready', state } })))
  await waitFor(() => expect(adapter.mock.calls.some(([config]) => config.url === '/api/inkos/ticket')).toBe(true))
  await act(async () => { await Promise.resolve() })
  fireEvent.load(frame)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(frame).toHaveAttribute('tabindex', '0')
  expect(frame).toHaveAttribute('aria-hidden', 'false')
})

it('dashboard same-origin configuration is rejected without a script-capable frame', () => {
  render(<InkosWorkspace userId={1} sessionId='dashboard-session' origin={window.location.origin} />)
  expect(screen.getByText('Invalid Inkos origin configuration')).toBeVisible()
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('root grant form validates IDs and confirms before saving then reads back grant state', async () => {
  login(1, 100)
  responses['/api/inkos/status'] = { ...status, allowed: false }
  mount()
  await screen.findByText('No explicit Inkos grants')
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('User ID'), '0')
  await user.click(screen.getByRole('button', { name: 'Review access change' }))
  expect(await screen.findByText('Enter a positive user ID')).toBeVisible()
  expect(screen.getByLabelText('User ID')).toHaveAttribute('aria-invalid', 'true')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  await user.clear(screen.getByLabelText('User ID'))
  await user.type(screen.getByLabelText('User ID'), '2')
  await user.click(screen.getByRole('button', { name: 'Review access change' }))
  const confirm = await screen.findByRole('alertdialog', { name: 'Grant Inkos access?' })
  expect(adapter.mock.calls.some(([config]) => config.method === 'put')).toBe(false)
  responses['/api/inkos/grants'] = [{ user_id: 2, allowed: true, token_id: 0 }]
  await user.click(within(confirm).getByRole('button', { name: 'Allow' }))
  await screen.findByRole('button', { name: 'Change Inkos access for user 2' })
  const request = adapter.mock.calls.find(([config]) => config.url === '/api/inkos/grants/2')?.[0]
  expect(request?.method).toBe('put')
  expect(JSON.parse(String(request?.data))).toEqual({ allowed: true })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it('failed root change keeps confirmation open instead of claiming saved', async () => {
  login(1, 100)
  responses['/api/inkos/grants'] = [{ user_id: 2, allowed: true, token_id: 7 }]
  adapter.mockImplementation(async (config) => ({ data: config.method === 'put' ? { success: false, message: 'User is disabled' } : { success: true, data: responses[config.url ?? ''] }, status: 200, statusText: 'OK', headers: {}, config }))
  mount()
  await userEvent.click(await screen.findByRole('button', { name: 'Change Inkos access for user 2' }))
  const dialog = screen.getByRole('alertdialog', { name: 'Revoke Inkos access?' })
  await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Revoke' })).toBeEnabled())
  expect(dialog).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(within(screen.getByRole('table', { name: 'Inkos access grants' })).getByText('Allowed')).toBeVisible()
})

it('binding an eligible own key sends only its ID and reads back the new binding', async () => {
  responses['/api/inkos/status'] = { ...status, token_id: 0 }
  mount()
  const select = await screen.findByRole('combobox', { name: 'Limited API key' })
  await userEvent.selectOptions(select, '7')
  responses['/api/inkos/status'] = status
  await userEvent.click(screen.getByRole('button', { name: 'Bind API key' }))
  expect(await screen.findByRole('button', { name: 'Open Inkos workspace' })).toBeEnabled()
  const request = adapter.mock.calls.find(([config]) => config.url === '/api/inkos/token')?.[0]
  expect(JSON.parse(String(request?.data))).toEqual({ token_id: 7 })
  expect(screen.getByRole('button', { name: 'Bind API key' })).toBeDisabled()
})

it('binding API failure keeps the user in the form and does not open a frame', async () => {
  responses['/api/inkos/status'] = { ...status, token_id: 0 }
  adapter.mockImplementation(async (config) => {
    if (config.method === 'put') throw new AxiosError('Forbidden', 'ERR_BAD_REQUEST', config, undefined, { data: { success: false, message: 'Key is ineligible' }, status: 403, statusText: 'Forbidden', headers: {}, config })
    return { data: { success: true, data: responses[config.url ?? ''] }, status: 200, statusText: 'OK', headers: {}, config }
  })
  mount()
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Limited API key' }), '7')
  await userEvent.click(screen.getByRole('button', { name: 'Bind API key' }))
  expect(await screen.findByText('Unable to bind Inkos API key')).toHaveAttribute('role', 'alert')
  expect(screen.queryByTitle('Inkos workspace')).not.toBeInTheDocument()
})

it('sidebar provides an actual local Inkos page entry rather than an external URL', () => {
  render(<SidebarEntry />)
  expect(screen.getByRole('link', { name: 'Inkos' })).toHaveAttribute('href', '/inkos')
})
