// app/routes/admin+/audit-logs.tsx
// Clean Audit Logs UI backed by AuditEvent (Option 1 migration: no legacy backfill)

import * as React from 'react'
import { type LoaderFunctionArgs, data, useLoaderData, Form } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, roles: { select: { name: true } } },
  })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const url = new URL(request.url)
  const search = url.searchParams.get('search')?.trim() || ''
  const actions = url.searchParams.getAll('action').filter(Boolean)
  const entityTypes = url.searchParams.getAll('entityType').filter(Boolean)
  const categories = url.searchParams.getAll('category').filter(Boolean)
  const statuses = url.searchParams.getAll('status').filter(Boolean)
  const chainKeys = url.searchParams.getAll('chainKey').filter(Boolean)
  const createdFrom = url.searchParams.get('createdFrom') || ''
  const createdTo = url.searchParams.get('createdTo') || ''
  const exportType = url.searchParams.get('export') || ''
  const cursor = url.searchParams.get('cursor') || ''
  const take = Math.min(500, Number(url.searchParams.get('take') || 200))

  const where: any = {}
  if (search) {
    where.OR = [
      { actorDisplay: { contains: search } },
      { actorId: { contains: search } },
      { entityId: { contains: search } },
      { summary: { contains: search } },
      { message: { contains: search } },
      { requestId: { contains: search } },
      { traceId: { contains: search } },
    ]
  }
  if (actions.length === 1) where.action = actions[0]
  else if (actions.length > 1) where.action = { in: actions }
  if (entityTypes.length === 1) where.entityType = entityTypes[0]
  else if (entityTypes.length > 1) where.entityType = { in: entityTypes }
  if (categories.length === 1) where.category = categories[0] as any
  else if (categories.length > 1) where.category = { in: categories as any }
  if (statuses.length === 1) where.status = statuses[0] as any
  else if (statuses.length > 1) where.status = { in: statuses as any }
  if (chainKeys.length === 1) where.chainKey = chainKeys[0]
  else if (chainKeys.length > 1) where.chainKey = { in: chainKeys }

  if (createdFrom || createdTo) {
    const range: any = {}
    if (createdFrom) {
      const d = new Date(createdFrom)
      if (!isNaN(d.getTime())) range.gte = d
    }
    if (createdTo) {
      const d = new Date(createdTo)
      if (!isNaN(d.getTime())) range.lte = d
    }
    if (Object.keys(range).length) where.createdAt = range
  }

  const fullExport = exportType === 'csv-full' || exportType === 'json-full'
  const effectiveTake = fullExport ? 5000 : take
  const logs = await prisma.auditEvent.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: fullExport ? effectiveTake : effectiveTake + 1, // fetch one extra to know if there's another page (unless full export)
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: {
      id: true,
      createdAt: true,
      actorDisplay: true,
      actorId: true,
      actorType: true,
      actorIp: true,
      actorUserAgent: true,
      customerId: true,
      category: true,
      action: true,
      status: true,
      entityType: true,
      entityId: true,
      requestId: true,
      traceId: true,
      spanId: true,
      summary: true,
      message: true,
      metadata: true,
      diff: true,
      seq: true,
      chainKey: true,
      hashPrev: true,
      hashSelf: true,
    },
  })

  // Distinct option sources (limited to recent period for performance if dataset grows)
  const [actionsDistinct, entityTypesDistinct, categoriesDistinct, statusesDistinct, chainKeysDistinct] = await Promise.all([
    prisma.auditEvent.findMany({ select: { action: true }, distinct: ['action'], orderBy: { action: 'asc' }, take: 400 }),
    prisma.auditEvent.findMany({ select: { entityType: true }, distinct: ['entityType'], orderBy: { entityType: 'asc' }, take: 400 }),
    prisma.auditEvent.findMany({ select: { category: true }, distinct: ['category'], orderBy: { category: 'asc' }, take: 50 }),
    prisma.auditEvent.findMany({ select: { status: true }, distinct: ['status'], orderBy: { status: 'asc' }, take: 10 }),
    prisma.auditEvent.findMany({ select: { chainKey: true }, distinct: ['chainKey'], orderBy: { chainKey: 'asc' }, take: 200 }),
  ])
  const actionsOptions = actionsDistinct.map(a => a.action).filter(Boolean)
  const entityTypeOptions = entityTypesDistinct.map(e => e.entityType).filter(Boolean)
  const categoryOptions = categoriesDistinct.map(c => c.category).filter(Boolean)
  const statusOptions = statusesDistinct.map(s => s.status).filter(Boolean)
  const chainKeyOptions = chainKeysDistinct.map(c => c.chainKey).filter(Boolean)

  let nextCursor: string | null = null
  let pageLogs = logs
  if (logs.length > take) {
    const extra = pageLogs.pop()
    nextCursor = extra?.id || null
  }

  if (exportType === 'csv' || exportType === 'json' || exportType === 'csv-full' || exportType === 'json-full') {
    const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0]
    if (exportType === 'json' || exportType === 'json-full') {
      const body = JSON.stringify({
        generatedAt: new Date().toISOString(),
        count: pageLogs.length,
        fullExport,
        filters: { search, actions, entityTypes, categories, statuses, chainKeys, take, cursor },
        logs: pageLogs,
      }, null, 2)
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-logs-${timestamp}${fullExport ? '-full' : ''}.json"`,
        },
      })
    }
    // CSV export
    const header = [
      'createdAt','category','action','status','actorDisplay','actorId','actorType','actorIp','entityType','entityId','requestId','traceId','spanId','summary','message','seq','chainKey','hashPrev','hashSelf','metadata','diff'
    ]
    const esc = (v: any) => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
      return s
    }
    const rows = pageLogs.map(l => header.map(h => {
      const val = (l as any)[h]
      if (h === 'metadata' || h === 'diff') return esc(val)
      return esc(val)
    }).join(','))
    const csv = [header.join(','), ...rows].join('\n')
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-logs-${timestamp}${fullExport ? '-full' : ''}.csv"`,
      },
    })
  }

  return data({
    user,
  logs: pageLogs,
  nextCursor,
  cursor,
    search,
    actions,
    entityTypes,
    categories,
    statuses,
    chainKeys,
    take,
    options: {
      actions: actionsOptions,
      entityTypes: entityTypeOptions,
      categories: categoryOptions,
      statuses: statusOptions,
      chainKeys: chainKeyOptions,
    },
    createdFrom,
    createdTo,
  })
}

function safeParse(json: string | null) {
  if (!json) return null
  try { return JSON.parse(json) } catch { return { _parseError: true } }
}

function toLocalInputValue(iso: string) {
  // Expecting iso string convertible to Date; format to yyyy-MM-ddTHH:mm for datetime-local
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function AdminAuditLogsPage() {
  const { user, logs, search, actions, entityTypes, categories, statuses, chainKeys, take, options, createdFrom, createdTo, nextCursor, cursor } = useLoaderData<typeof loader>()
  const isPending = useIsPending()
  const [visibleCols, setVisibleCols] = React.useState<string[]>(() => {
    if (typeof window === 'undefined') return [] as string[]
    try {
      const saved = localStorage.getItem('auditCols')
      const parsed = saved ? JSON.parse(saved) : []
      return Array.isArray(parsed) ? parsed as string[] : []
    } catch { return [] as string[] }
  })

  const allCols = React.useMemo(() => [
    { key: 'actor', label: 'Actor' },
    { key: 'category', label: 'Category' },
    { key: 'action', label: 'Action' },
    { key: 'entity', label: 'Entity' },
    { key: 'status', label: 'Status' },
    { key: 'summary', label: 'Summary/Msg' },
    { key: 'chain', label: 'Chain' },
    { key: 'raw', label: 'Raw JSON' },
  ], [])

  React.useEffect(() => {
    if (visibleCols.length === 0) {
      // default set
      const defaults = ['actor','category','action','entity','status','summary','chain','raw']
      setVisibleCols(defaults)
      try { localStorage.setItem('auditCols', JSON.stringify(defaults)) } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleCol = (k: string) => {
    setVisibleCols(prev => {
      const next = prev.includes(k) ? prev.filter(p => p !== k) : [...prev, k]
      try { localStorage.setItem('auditCols', JSON.stringify(next)) } catch {}
      return next
    })
  }

  const CopyBtn = ({ value, label }: { value?: string; label: string }) => {
    if (!value) return null
    return (
      <button
        type="button"
        onClick={() => { navigator.clipboard.writeText(value).catch(()=>{}) }}
        className="ml-1 text-[10px] text-blue-600 hover:underline"
        title={`Copy ${label}`}
      >copy</button>
    )
  }
  return (
    <InterexLayout
      user={user}
      title="Audit Logs"
      subtitle="Tamper-evident system & tenant activity"
      showBackButton
      backTo="/admin"
      currentPath="/admin/audit-logs"
    >
      <LoadingOverlay show={Boolean(isPending)} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        <div className="bg-white shadow rounded-md p-4">
          <Form method="get" className="flex flex-wrap items-end gap-3">
            <FilterField label="Search" name="search" defaultValue={search} placeholder="actor / entityId / summary / traceId" />
            <MultiSelectDropdown label="Action" name="action" values={actions} options={options.actions} />
            <MultiSelectDropdown label="Entity" name="entityType" values={entityTypes} options={options.entityTypes} />
            <MultiSelectDropdown label="Category" name="category" values={categories} options={options.categories} />
            <MultiSelectDropdown label="Status" name="status" values={statuses} options={options.statuses} />
            <MultiSelectDropdown label="Chain" name="chainKey" values={chainKeys} options={options.chainKeys} />
            <div className="flex flex-col">
              <label className="text-xs text-gray-500">From</label>
              <input name="createdFrom" type="datetime-local" defaultValue={createdFrom ? toLocalInputValue(createdFrom) : ''} className="border rounded px-2 py-1 text-xs" />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-gray-500">To</label>
              <input name="createdTo" type="datetime-local" defaultValue={createdTo ? toLocalInputValue(createdTo) : ''} className="border rounded px-2 py-1 text-xs" />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-gray-500">Limit</label>
              <input name="take" type="number" min={1} max={500} defaultValue={take} className="border rounded px-2 py-1 text-sm w-24" />
            </div>
            <div className="flex gap-2 items-end pb-1">
              <button className="bg-gray-800 text-white text-sm rounded px-3 py-1.5" type="submit">Apply</button>
              <button className="bg-blue-600 text-white text-sm rounded px-3 py-1.5" type="submit" name="export" value="csv" title="CSV (current page)">CSV</button>
              <button className="bg-emerald-600 text-white text-sm rounded px-3 py-1.5" type="submit" name="export" value="json" title="JSON (current page)">JSON</button>
              <button className="bg-blue-900 text-white text-sm rounded px-3 py-1.5" type="submit" name="export" value="csv-full" title="CSV full (ignores pagination, up to 5000)">CSV Full</button>
              <button className="bg-emerald-900 text-white text-sm rounded px-3 py-1.5" type="submit" name="export" value="json-full" title="JSON full (ignores pagination, up to 5000)">JSON Full</button>
            </div>
          </Form>
        </div>
        <div className="bg-white shadow rounded-md overflow-x-auto">
          <details className="mb-2 text-xs">
            <summary className="cursor-pointer select-none px-3 py-1 text-gray-600">Columns</summary>
            <div className="flex flex-wrap gap-3 px-3 pb-2">
              {allCols.map(c => (
                <label key={c.key} className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={visibleCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </details>
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <Th>Time</Th>
                {visibleCols.includes('actor') && <Th>Actor</Th>}
                {visibleCols.includes('category') && <Th>Category</Th>}
                {visibleCols.includes('action') && <Th>Action</Th>}
                {visibleCols.includes('entity') && <Th>Entity</Th>}
                {visibleCols.includes('status') && <Th>Status</Th>}
                {visibleCols.includes('summary') && <Th>Summary / Message</Th>}
                {visibleCols.includes('chain') && <Th>Chain</Th>}
                {visibleCols.includes('raw') && <Th>Raw</Th>}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {logs.length === 0 ? (
                <tr><td colSpan={1 + visibleCols.length} className="px-4 py-6 text-sm text-gray-500 text-center">No logs.</td></tr>
              ) : logs.map((row: any) => {
                const metadata = safeParse(row.metadata)
                const diff = safeParse(row.diff)
                return (
                  <tr key={row.id} className="hover:bg-gray-50 align-top">
                    <Td className="whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</Td>
                    {visibleCols.includes('actor') && (
                      <Td>
                        <div className="text-gray-900 text-[11px]">{row.actorDisplay || row.actorId || '—'}</div>
                        <div className="text-gray-500 text-[10px]">{row.actorType}</div>
                        {row.actorIp && <div className="text-gray-400 text-[10px]">{row.actorIp}</div>}
                      </Td>
                    )}
                    {visibleCols.includes('category') && <Td>{row.category}</Td>}
                    {visibleCols.includes('action') && <Td className="font-mono">{row.action}</Td>}
                    {visibleCols.includes('entity') && (
                      <Td>
                        <div>{row.entityType || '—'}</div>
                        <div className="text-gray-500 text-[10px]">{row.entityId || '—'} <CopyBtn value={row.entityId} label="entityId" /></div>
                      </Td>
                    )}
                    {visibleCols.includes('status') && (
                      <Td>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${row.status === 'SUCCESS' ? 'bg-green-50 text-green-700 border-green-200' : row.status === 'FAILURE' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-gray-50 text-gray-700 border-gray-200'}`}>{row.status}</span>
                      </Td>
                    )}
                    {visibleCols.includes('summary') && (
                      <Td className="max-w-xs">
                        <div className="text-gray-900 truncate" title={row.summary || row.message || ''}>{row.summary || '—'}</div>
                        {row.message && <div className="text-gray-500 truncate text-[11px]" title={row.message}>{row.message}</div>}
                        {(row.requestId || row.traceId) && (
                          <div className="text-[10px] text-gray-400 mt-1 space-y-0.5">
                            {row.requestId && <div>req: {row.requestId} <CopyBtn value={row.requestId} label="requestId" /></div>}
                            {row.traceId && <div>trace: {row.traceId} <CopyBtn value={row.traceId} label="traceId" /></div>}
                          </div>
                        )}
                      </Td>
                    )}
                    {visibleCols.includes('chain') && (
                      <Td className="font-mono break-all max-w-[180px] text-[10px]">
                        <div className="text-gray-600">{row.chainKey} <CopyBtn value={row.chainKey} label="chainKey" /></div>
                        <div className="text-gray-400">seq #{row.seq}</div>
                        <div className="text-gray-400" title={row.hashSelf}>hash {row.hashSelf.slice(0, 12)}… <CopyBtn value={row.hashSelf} label="hashSelf" /></div>
                      </Td>
                    )}
                    {visibleCols.includes('raw') && (
                      <Td className="text-[11px]">
                        <JsonViewer data={{ metadata, diff, hashes: { prev: row.hashPrev, self: row.hashSelf }, actor: { ua: row.actorUserAgent } }} />
                      </Td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-gray-600">
            <div>
              Showing {logs.length} {logs.length === 1 ? 'event' : 'events'}{cursor ? ' (continued)' : ''}
            </div>
            <div className="flex gap-2">
              {nextCursor && (
                <Form method="get" className="inline">
                  {/* Preserve existing params */}
                  <input type="hidden" name="search" value={search} />
                  {actions.map(a => <input key={a} type="hidden" name="action" value={a} />)}
                  {entityTypes.map(e => <input key={e} type="hidden" name="entityType" value={e} />)}
                  {categories.map(c => <input key={c} type="hidden" name="category" value={c} />)}
                  {statuses.map(s => <input key={s} type="hidden" name="status" value={s} />)}
                  {chainKeys.map(c => <input key={c} type="hidden" name="chainKey" value={c} />)}
                  {createdFrom && <input type="hidden" name="createdFrom" value={createdFrom} />}
                  {createdTo && <input type="hidden" name="createdTo" value={createdTo} />}
                  <input type="hidden" name="take" value={take} />
                  <input type="hidden" name="cursor" value={nextCursor} />
                  <button className="bg-gray-800 text-white rounded px-3 py-1.5">Next →</button>
                </Form>
              )}
              {cursor && (
                <Form method="get" className="inline">
                  <input type="hidden" name="search" value={search} />
                  {actions.map(a => <input key={a} type="hidden" name="action" value={a} />)}
                  {entityTypes.map(e => <input key={e} type="hidden" name="entityType" value={e} />)}
                  {categories.map(c => <input key={c} type="hidden" name="category" value={c} />)}
                  {statuses.map(s => <input key={s} type="hidden" name="status" value={s} />)}
                  {chainKeys.map(c => <input key={c} type="hidden" name="chainKey" value={c} />)}
                  {createdFrom && <input type="hidden" name="createdFrom" value={createdFrom} />}
                  {createdTo && <input type="hidden" name="createdTo" value={createdTo} />}
                  <input type="hidden" name="take" value={take} />
                  <button className="bg-gray-100 text-gray-700 border rounded px-3 py-1.5">Refresh</button>
                </Form>
              )}
            </div>
          </div>
        </div>
      </div>
    </InterexLayout>
  )
}

function FilterField(props: { label: string; name: string; defaultValue: string; placeholder?: string }) {
  return (
    <div className="flex flex-col">
      <label className="text-xs text-gray-500">{props.label}</label>
      <input name={props.name} defaultValue={props.defaultValue} placeholder={props.placeholder} className="border rounded px-2 py-1 text-sm" />
    </div>
  )
}

// Compact multi-select dropdown with checkbox list & filtering
function MultiSelectDropdown(props: { label: string; name: string; values: string[]; options: string[] }) {
  const { label, name } = props
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>(props.values)
  const [filter, setFilter] = React.useState('')
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)

  const valuesKey = React.useMemo(() => props.values.slice().sort().join('|'), [props.values])
  React.useEffect(() => { setSelected(props.values) }, [valuesKey, props.values])

  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const toggle = (val: string) => {
    setSelected(prev => prev.includes(val) ? prev.filter(v => v !== val) : [...prev, val])
  }
  const clear = () => setSelected([])
  const visibleOptions = props.options.filter(o => !filter || o.toLowerCase().includes(filter.toLowerCase()))
  const summary = selected.length === 0 ? 'Any' : selected.length <= 2 ? selected.join(', ') : `${selected.length} selected`

  return (
    <div className="flex flex-col min-w-[170px]" ref={wrapperRef}>
      <label className="text-xs text-gray-500 mb-0.5">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`border rounded px-2 py-1 text-xs text-left bg-white hover:border-gray-400 focus:outline-none focus:ring w-full ${selected.length ? 'text-gray-800' : 'text-gray-400'}`}
        title={summary}
      >{summary}</button>
      {selected.map(v => <input key={v} type="hidden" name={name} value={v} />)}
      {open && (
        <div className="absolute z-30 mt-1 w-64 bg-white border rounded shadow-lg p-1 flex flex-col gap-1 max-h-72 overflow-hidden">
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="border rounded px-2 py-1 text-xs w-full"
          />
          <ul className="overflow-auto flex-1 pr-1 text-xs">
            {visibleOptions.length === 0 && (
              <li className="px-2 py-2 text-gray-400">No matches</li>
            )}
            {visibleOptions.map(o => {
              const checked = selected.includes(o)
              return (
                <li key={o}>
                  <label className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-gray-50 rounded">
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={checked}
                      onChange={() => toggle(o)}
                    />
                    <span className="font-mono truncate" title={o}>{o}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          <div className="flex justify-between items-center gap-2 pt-1 border-t">
            <button type="button" onClick={clear} className="text-[10px] text-gray-600 hover:text-gray-900">Clear</button>
            <div className="flex gap-1">
              <button type="button" onClick={() => setOpen(false)} className="text-[10px] bg-gray-100 hover:bg-gray-200 rounded px-2 py-1">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{children}</th>
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 text-[11px] align-top ${className}`}>{children}</td>
}