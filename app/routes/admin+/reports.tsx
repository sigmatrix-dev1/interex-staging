// app/routes/admin+/reports.tsx
// System Admin Reports hub: submissions, letters, eMDR, NPIs, security, compliance

import * as React from 'react'
import { type LoaderFunctionArgs, data, useLoaderData, Form } from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

type DateRange = { from?: Date; to?: Date }

// Accepts YYYY-MM-DD (date-only) or full ISO strings. For date-only:
// - from => start of day 00:00:00.000 local
// - to   => end of day 23:59:59.999 local
function parseDateRange(fromStr?: string | null, toStr?: string | null): DateRange {
  const range: DateRange = {}
  const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

  if (fromStr) {
    if (isDateOnly(fromStr)) {
      const parts = fromStr.split('-').map((n) => Number(n))
      const y = parts[0] ?? 1970
      const m = (parts[1] ?? 1) - 1
      const d = parts[2] ?? 1
      range.from = new Date(y, m, d, 0, 0, 0, 0)
    } else {
      const d = new Date(fromStr)
      if (!isNaN(d.getTime())) range.from = d
    }
  }
  if (toStr) {
    if (isDateOnly(toStr)) {
      const parts = toStr.split('-').map((n) => Number(n))
      const y = parts[0] ?? 1970
      const m = (parts[1] ?? 1) - 1
      const d = parts[2] ?? 1
      range.to = new Date(y, m, d, 23, 59, 59, 999)
    } else {
      const d = new Date(toStr)
      if (!isNaN(d.getTime())) range.to = d
    }
  }
  return range
}

function toLocalDateValue(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toCsv(rows: Array<Record<string, any>>): string {
  if (!rows.length) return ''
  const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r))))
  const esc = (v: any) => {
    if (v == null) return ''
    const s = String(v)
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))]
  return lines.join('\n')
}

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, roles: { select: { name: true } } } })
  if (!user) throw new Response('Unauthorized', { status: 401 })
  requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

  const url = new URL(request.url)
  const selectedCustomerId = url.searchParams.get('customerId') || ''
  const createdFrom = url.searchParams.get('createdFrom') || ''
  const createdTo = url.searchParams.get('createdTo') || ''
  const section = url.searchParams.get('exportSection') || '' // when present => CSV export
  const format = (url.searchParams.get('format') || 'csv').toLowerCase()
  // Per-section pages
  const getPage = (param: string) => Math.max(1, Number(url.searchParams.get(param) || 1))
  const submissionsPage = getPage('submissionsPage')
  const npisPage = getPage('npisPage')
  const securityPage = getPage('securityPage')
  const uploadsPage = getPage('uploadsPage')
  const anomaliesPage = getPage('anomaliesPage')
  // Fixed page size across sections
  const pageSize = 250
  const range = parseDateRange(createdFrom, createdTo)

  // Load customers for filter dropdown
  const customers = await prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } })

  const hasCustomer = Boolean(selectedCustomerId)
  const whereCustomer = hasCustomer ? { customerId: selectedCustomerId } : {}

  // Helper date filter per model field
  const dateWhere = (field: string) => {
    const w: any = {}
    if (range.from || range.to) {
      w[field] = {}
      if (range.from) w[field].gte = range.from
      if (range.to) w[field].lte = range.to
    }
    return w
  }

  // Submissions
  async function buildSubmissions(page: number, paginate = true) {
    const where: any = { ...whereCustomer, ...dateWhere('createdAt') }
    const list = await prisma.submission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: {
        title: true,
        status: true,
        purposeOfSubmission: true,
        recipient: true,
        claimId: true,
        caseId: true,
        comments: true,
        authorType: true,
        autoSplit: true,
        sendInX12: true,
        threshold: true,
        createdAt: true,
        submittedAt: true,
        provider: { select: { npi: true, name: true } },
        documents: { select: { attachmentControlNumber: true, fileName: true, originalFileName: true } },
      },
    })
    const hasMore = paginate && list.length > pageSize
    const trimmed = hasMore ? list.slice(0, pageSize) : list
    const countsByStatus: Record<string, number> = {}
    for (const s of trimmed) countsByStatus[s.status] = (countsByStatus[s.status] || 0) + 1
    const rows = trimmed.map(s => ({
      title: s.title,
      status: s.status,
      purpose: s.purposeOfSubmission,
      recipient: s.recipient,
      claimId: s.claimId || '',
      caseId: s.caseId || '',
      authorType: s.authorType,
      autoSplit: s.autoSplit,
      sendInX12: s.sendInX12,
      threshold: s.threshold,
      createdAt: s.createdAt.toISOString(),
      submittedAt: s.submittedAt ? s.submittedAt.toISOString() : '',
      providerNpi: s.provider?.npi || '',
      providerName: s.provider?.name || '',
      docCount: s.documents.length,
      acns: s.documents.map(d => d.attachmentControlNumber).filter(Boolean).join('; '),
      fileNames: s.documents.map(d => d.fileName).filter(Boolean).join('; '),
      originalNames: s.documents.map(d => d.originalFileName).filter(Boolean).join('; '),
      comments: s.comments || '',
    }))
    return { rows, countsByStatus, hasMore }
  }

  // Letters (prepay/postpay/other)
  async function buildLetters() {
    const whereBase: any = { ...whereCustomer }
    const dateW = dateWhere('createdAt')
    const [prepay, postpay, other] = await Promise.all([
      prisma.prepayLetter.findMany({ where: { ...whereBase, ...dateW }, orderBy: { createdAt: 'desc' }, select: { id: true, externalLetterId: true, providerNpi: true, letterDate: true, respondBy: true, stage: true, language: true, createdAt: true } }),
      prisma.postpayLetter.findMany({ where: { ...whereBase, ...dateW }, orderBy: { createdAt: 'desc' }, select: { id: true, externalLetterId: true, providerNpi: true, letterDate: true, respondBy: true, stage: true, language: true, createdAt: true } }),
      prisma.postpayOtherLetter.findMany({ where: { ...whereBase, ...dateW }, orderBy: { createdAt: 'desc' }, select: { id: true, externalLetterId: true, providerNpi: true, letterDate: true, respondBy: true, stage: true, language: true, createdAt: true } }),
    ])
    const rows = [
      ...prepay.map(l => ({ type: 'PREPAY', ...l })),
      ...postpay.map(l => ({ type: 'POSTPAY', ...l })),
      ...other.map(l => ({ type: 'POSTPAY_OTHER', ...l })),
    ].map(l => ({
      type: l.type,
      id: l.id,
      externalLetterId: l.externalLetterId,
      providerNpi: l.providerNpi,
      letterDate: l.letterDate ? new Date(l.letterDate).toISOString() : '',
      respondBy: l.respondBy ? new Date(l.respondBy).toISOString() : '',
      stage: l.stage || '',
      language: l.language || '',
      createdAt: l.createdAt.toISOString(),
    }))
    const counts = { PREPAY: prepay.length, POSTPAY: postpay.length, POSTPAY_OTHER: other.length }
    return { rows, counts }
  }

  // eMDR (registration/list details)
  async function buildEmdr() {
    const providers = await prisma.provider.findMany({
      where: { ...whereCustomer },
      select: {
        id: true, npi: true, name: true, active: true,
        listDetail: { select: { registeredForEmdr: true, registeredForEmdrElectronicOnly: true, stage: true, regStatus: true, status: true, fetchedAt: true } },
        registrationStatus: { select: { regStatus: true, stage: true, status: true, fetchedAt: true } },
      },
    })
    const rows = providers.map(p => ({
      providerId: p.id,
      npi: p.npi,
      name: p.name || '',
      active: p.active,
      registered: p.listDetail?.registeredForEmdr || false,
      electronicOnly: p.listDetail?.registeredForEmdrElectronicOnly || false,
      listStage: p.listDetail?.stage || '',
      listRegStatus: p.listDetail?.regStatus || '',
      listStatus: p.listDetail?.status || '',
      listFetchedAt: p.listDetail?.fetchedAt ? p.listDetail?.fetchedAt.toISOString() : '',
      regStage: p.registrationStatus?.stage || '',
      regStatus: p.registrationStatus?.regStatus || '',
      regFetchedAt: p.registrationStatus?.fetchedAt ? p.registrationStatus?.fetchedAt.toISOString() : '',
    }))
    const counts = {
      totalProviders: providers.length,
      registered: providers.filter(p => p.listDetail?.registeredForEmdr).length,
      electronicOnly: providers.filter(p => p.listDetail?.registeredForEmdrElectronicOnly).length,
    }
    return { rows, counts }
  }

  // NPIs / Providers
  async function buildNpis(page: number, paginate = true) {
    const providers = await prisma.provider.findMany({
      where: { ...whereCustomer, ...dateWhere('createdAt') },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: {
        id: true, npi: true, name: true, active: true, createdAt: true,
        providerGroup: { select: { id: true, name: true } },
        _count: { select: { userNpis: true, submissions: true } },
      },
    })
    const hasMore = paginate && providers.length > pageSize
    const trimmed = hasMore ? providers.slice(0, pageSize) : providers
    const rows = trimmed.map(p => ({
      id: p.id,
      npi: p.npi,
      name: p.name || '',
      active: p.active,
      providerGroup: p.providerGroup?.name || '',
      createdAt: p.createdAt.toISOString(),
      assignedUsers: p._count.userNpis,
      submissions: p._count.submissions,
    }))
    const counts = {
      total: rows.length,
      active: trimmed.filter(p => p.active).length,
      inactive: trimmed.filter(p => !p.active).length,
      ungrouped: trimmed.filter(p => !p.providerGroup).length,
    }
    return { rows, counts, hasMore }
  }

  // Security & Audit
  async function buildSecurity(page: number, paginate = true) {
    const secEvents = await prisma.securityEvent.findMany({
      where: { ...whereCustomer, ...dateWhere('createdAt') },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: { id: true, createdAt: true, kind: true, success: true, userId: true, userEmail: true, ip: true, reason: true },
    })
    const auditEvents = await prisma.auditEvent.findMany({
      where: { ...whereCustomer, ...dateWhere('createdAt') },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: { id: true, createdAt: true, category: true, action: true, status: true, actorDisplay: true, actorId: true, entityType: true, entityId: true, summary: true },
    })
    const secHasMore = paginate && secEvents.length > pageSize
    const auditHasMore = paginate && auditEvents.length > pageSize
    const rows = {
      security: (secHasMore ? secEvents.slice(0, pageSize) : secEvents).map(e => ({ id: e.id, createdAt: e.createdAt.toISOString(), kind: e.kind, success: e.success, userId: e.userId || '', userEmail: e.userEmail || '', ip: e.ip || '', reason: e.reason || '' })),
      audit: (auditHasMore ? auditEvents.slice(0, pageSize) : auditEvents).map(a => ({ id: a.id, createdAt: a.createdAt.toISOString(), category: a.category, action: a.action, status: a.status, actor: a.actorDisplay || a.actorId || '', entityType: a.entityType || '', entityId: a.entityId || '', summary: a.summary || '' })),
    }
    return { ...rows, hasMore: secHasMore || auditHasMore }
  }

  // Document uploads (SubmissionDocument), with failure focus
  async function buildDocumentUploads(page: number, paginate = true) {
    const docs = await prisma.submissionDocument.findMany({
      where: { ...(hasCustomer ? { submission: { customerId: selectedCustomerId } } : {}), ...dateWhere('createdAt') },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        fileName: true,
        originalFileName: true,
        fileSize: true,
        mimeType: true,
        uploadStatus: true,
        attachmentControlNumber: true,
        submission: { select: { id: true, title: true, status: true, provider: { select: { npi: true } } } },
        uploader: { select: { email: true, name: true } },
      },
    })
    const hasMore = paginate && docs.length > pageSize
    const trimmed = hasMore ? docs.slice(0, pageSize) : docs
    const rows = trimmed.map(d => ({
      id: d.id,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      submissionId: d.submission?.id || '',
      submissionTitle: d.submission?.title || '',
      submissionStatus: d.submission?.status || '',
      providerNpi: d.submission?.provider?.npi || '',
      uploader: d.uploader?.name || d.uploader?.email || '',
      fileName: d.fileName,
      originalFileName: d.originalFileName,
      fileSize: d.fileSize,
      mimeType: d.mimeType,
      status: d.uploadStatus,
      acn: d.attachmentControlNumber || '',
    }))
    const summary = {
      total: rows.length,
      pending: rows.filter(r => r.status === 'PENDING').length,
      uploading: rows.filter(r => r.status === 'UPLOADING').length,
      uploaded: rows.filter(r => r.status === 'UPLOADED').length,
      failed: rows.filter(r => r.status === 'UPLOAD_FAILED').length,
    }
    const failures = rows.filter(r => r.status === 'UPLOAD_FAILED')
    return { rows, summary, failures, hasMore }
  }

  // Security anomalies: failed logins, access denied, rate limits, and any audit ERROR/WARNING
  async function buildSecurityAnomalies(page: number, paginate = true) {
    const suspiciousKinds = ['LOGIN', 'MFA_VERIFY', 'ACCESS_DENIED', 'RATE_LIMIT', 'PASSWORD_RESET', 'ADMIN_ACTION']
    const sec = await prisma.securityEvent.findMany({
      where: { ...whereCustomer, ...dateWhere('createdAt'), OR: [{ success: false }, { kind: { in: suspiciousKinds } }] },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: { id: true, createdAt: true, kind: true, success: true, userEmail: true, ip: true, reason: true },
    })
    const aud = await prisma.auditEvent.findMany({
      where: { ...whereCustomer, ...dateWhere('createdAt'), OR: [{ status: 'FAILURE' }, { status: 'WARNING' }, { category: 'SECURITY' }, { category: 'ERROR' }] },
      orderBy: { createdAt: 'desc' },
      ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize + 1 } : {}),
      select: { id: true, createdAt: true, category: true, action: true, status: true, actorDisplay: true, entityType: true, entityId: true, message: true },
    })
    const secHasMore = paginate && sec.length > pageSize
    const audHasMore = paginate && aud.length > pageSize
    const rows = {
      security: (secHasMore ? sec.slice(0, pageSize) : sec).map(s => ({ id: s.id, createdAt: s.createdAt.toISOString(), kind: s.kind, success: s.success, user: s.userEmail || '', ip: s.ip || '', reason: s.reason || '' })),
      audit: (audHasMore ? aud.slice(0, pageSize) : aud).map(a => ({ id: a.id, createdAt: a.createdAt.toISOString(), category: a.category, action: a.action, status: a.status, actor: a.actorDisplay || '', entityType: a.entityType || '', entityId: a.entityId || '', message: a.message || '' })),
    }
    const counts = { security: rows.security.length, audit: rows.audit.length }
    return { rows, counts, hasMore: secHasMore || audHasMore }
  }

  // Compliance snapshot
  async function buildCompliance() {
    if (!hasCustomer) return { rows: [], summary: {} }
    const [cust, users] = await Promise.all([
      prisma.customer.findUnique({ where: { id: selectedCustomerId }, select: { id: true, name: true, baaNumber: true, baaDate: true } }),
      prisma.user.findMany({ where: { customerId: selectedCustomerId }, select: { id: true, email: true, name: true, twoFactorEnabled: true, mustChangePassword: true, active: true } }),
    ])
    const totalUsers = users.length
    const twoFactorEnabled = users.filter(u => u.twoFactorEnabled).length
    const mustChangePassword = users.filter(u => u.mustChangePassword).length
    const inactiveUsers = users.filter(u => !u.active).length
    const rows = users.map(u => ({ id: u.id, name: u.name || '', email: u.email, twoFactorEnabled: u.twoFactorEnabled, mustChangePassword: u.mustChangePassword, active: u.active }))
    const summary = {
      baaNumber: cust?.baaNumber || '',
      baaDate: cust?.baaDate ? cust?.baaDate.toISOString().slice(0, 10) : '',
      totalUsers,
      twoFactorEnabled,
      twoFactorDisabled: totalUsers - twoFactorEnabled,
      mustChangePassword,
      inactiveUsers,
    }
    return { rows, summary }
  }

  // Handle CSV export per section
  if (section && format === 'csv') {
    const filename = (base: string) => `${base}-${selectedCustomerId || 'all'}-${Date.now()}.csv`
    if (section === 'submissions') {
  const { rows } = await buildSubmissions(1, false)
      return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('submissions')}` } })
    }
    if (section === 'letters') {
      const { rows } = await buildLetters()
      return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('letters')}` } })
    }
    if (section === 'emdr') {
      const { rows } = await buildEmdr()
      return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('emdr')}` } })
    }
    if (section === 'npis') {
  const { rows } = await buildNpis(1, false)
      return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('npis')}` } })
    }
    if (section === 'security') {
  const rows = await buildSecurity(1, false)
      // export security + audit as two CSV blocks concatenated with headers
      const csv = `# Security Events\n${toCsv(rows.security)}\n\n# Audit Events\n${toCsv(rows.audit)}`
      return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('security')}` } })
    }
      if (section === 'doc-uploads') {
  const { rows, summary, failures } = await buildDocumentUploads(1, false)
        const csv = `# Summary\n${toCsv([summary as any])}\n\n# All Uploads\n${toCsv(rows)}\n\n# Failures\n${toCsv(failures)}`
        return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('document-uploads')}` } })
      }
      if (section === 'security-anomalies') {
  const { rows, counts } = await buildSecurityAnomalies(1, false)
        const csv = `# Counts\n${toCsv([counts as any])}\n\n# Security\n${toCsv(rows.security)}\n\n# Audit\n${toCsv(rows.audit)}`
        return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('security-anomalies')}` } })
      }
    if (section === 'compliance') {
      const { rows, summary } = await buildCompliance()
      const csv = `# Compliance Summary\n${toCsv([summary as any])}\n\n# Users\n${toCsv(rows)}`
      return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename=${filename('compliance')}` } })
    }
  }

  // Build dashboard data for UI
  let submissions = { rows: [] as any[], countsByStatus: {} as Record<string, number>, hasMore: false }
  let letters = { rows: [] as any[], counts: { PREPAY: 0, POSTPAY: 0, POSTPAY_OTHER: 0 } }
  let emdr = { rows: [] as any[], counts: { totalProviders: 0, registered: 0, electronicOnly: 0 } }
  let npis = { rows: [] as any[], counts: { total: 0, active: 0, inactive: 0, ungrouped: 0 }, hasMore: false }
  let security = { security: [] as any[], audit: [] as any[], hasMore: false }
  let compliance = { rows: [] as any[], summary: {} as any }
  let docUploads = { rows: [] as any[], summary: {} as any, failures: [] as any[], hasMore: false }
  let anomalies = { rows: { security: [] as any[], audit: [] as any[] }, counts: { security: 0, audit: 0 }, hasMore: false }

  if (hasCustomer) {
    ;[submissions, letters, emdr, npis, security, compliance, docUploads, anomalies] = await Promise.all([
      buildSubmissions(submissionsPage, true),
      buildLetters(),
      buildEmdr(),
      buildNpis(npisPage, true),
      buildSecurity(securityPage, true),
      buildCompliance(),
      buildDocumentUploads(uploadsPage, true),
      buildSecurityAnomalies(anomaliesPage, true),
    ])
  }

  return data({
    user,
    customers,
    selectedCustomerId,
    createdFrom,
    createdTo,
  pageSize,
  submissionsPage,
  npisPage,
  securityPage,
  uploadsPage,
  anomaliesPage,
    submissions,
    letters,
    emdr,
    npis,
    security,
    compliance,
      docUploads,
      anomalies,
  })
}

export default function AdminReportsPage() {
  const { user, customers, selectedCustomerId, createdFrom, createdTo, submissions, letters, emdr, npis, security, compliance, docUploads, anomalies, pageSize, submissionsPage, npisPage, securityPage, uploadsPage, anomaliesPage } = useLoaderData<typeof loader>()
  const isPending = useIsPending()
  const [customerId, setCustomerId] = React.useState(selectedCustomerId)
  // Local copies per section (for potential future client-side adjustments)
  const [localSubPage, setLocalSubPage] = React.useState(submissionsPage)
  const [localNpiPage, setLocalNpiPage] = React.useState(npisPage)
  const [localSecPage, setLocalSecPage] = React.useState(securityPage)
  const [localUploadPage, setLocalUploadPage] = React.useState(uploadsPage)
  const [localAnomPage, setLocalAnomPage] = React.useState(anomaliesPage)

  const hasCustomer = Boolean(customerId)
  const baseParams = (extras?: Record<string, string>) => {
    const p = new URLSearchParams()
    if (customerId) p.set('customerId', customerId)
    if (createdFrom) p.set('createdFrom', createdFrom)
    if (createdTo) p.set('createdTo', createdTo)
    p.set('submissionsPage', String(localSubPage))
    p.set('npisPage', String(localNpiPage))
    p.set('securityPage', String(localSecPage))
    p.set('uploadsPage', String(localUploadPage))
    p.set('anomaliesPage', String(localAnomPage))
    Object.entries(extras || {}).forEach(([k, v]) => p.set(k, v))
    return p.toString()
  }

  function SectionPager({ page, hasMore, param, makeParams, label }: { page: number; hasMore: boolean; param: string; makeParams: (e?: Record<string, string>) => string; label: string }) {
    if (!customerId) return null
    return (
      <div className="flex items-center justify-between mt-2 text-[11px] text-gray-600 border-t pt-2">
        <div>{label} Page <span className="font-semibold">{page}</span> • Size {pageSize}</div>
        <div className="flex items-center gap-2">
          {page > 1 && (
            <a href={`?${makeParams({ [param]: String(page - 1) })}#${label.toLowerCase().replace(/\s+/g,'-')}`} className="px-2 py-1 rounded border text-xs bg-white hover:bg-gray-50">Prev</a>
          )}
          {hasMore && (
            <a href={`?${makeParams({ [param]: String(page + 1) })}#${label.toLowerCase().replace(/\s+/g,'-')}`} className="px-2 py-1 rounded border text-xs bg-white hover:bg-gray-50">Next</a>
          )}
        </div>
      </div>
    )
  }

  return (
    <InterexLayout user={user} title="Reports" subtitle="System-wide and tenant-specific reports" showBackButton backTo="/admin/dashboard" currentPath="/admin/reports">
      <LoadingOverlay show={Boolean(isPending)} />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="bg-white shadow rounded-md p-4" id="top">
          <Form method="get" className="flex flex-wrap items-end gap-3" onSubmit={() => {
            // Reset all section pages on filter change
            setLocalSubPage(1); setLocalNpiPage(1); setLocalSecPage(1); setLocalUploadPage(1); setLocalAnomPage(1)
          }}>
            <div className="flex flex-col min-w-[260px]">
              <label className="text-xs text-gray-500 mb-0.5">Customer</label>
              <select name="customerId" value={customerId} onChange={e => setCustomerId(e.target.value)} className="border rounded px-2 py-1 text-sm">
                <option value="">— Select a customer —</option>
                {customers.map((c: any) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-gray-500">From</label>
              <input name="createdFrom" type="date" defaultValue={toLocalDateValue(createdFrom)} className="border rounded px-2 py-1 text-xs" />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-gray-500">To</label>
              <input name="createdTo" type="date" defaultValue={toLocalDateValue(createdTo)} className="border rounded px-2 py-1 text-xs" />
            </div>
            {/* Hidden per-section page inputs */}
            <input type="hidden" name="submissionsPage" value={localSubPage} />
            <input type="hidden" name="npisPage" value={localNpiPage} />
            <input type="hidden" name="securityPage" value={localSecPage} />
            <input type="hidden" name="uploadsPage" value={localUploadPage} />
            <input type="hidden" name="anomaliesPage" value={localAnomPage} />
            <div className="flex items-end pb-1 gap-2">
              <button className="bg-gray-800 text-white text-sm rounded px-3 py-1.5" type="submit">Apply</button>
            </div>
          </Form>
          {hasCustomer ? (<div className="mt-2 text-[11px] text-gray-500">Page size fixed at 250 per section.</div>) : null}
        </div>

        {!hasCustomer ? (
          <div className="text-gray-600 text-sm">Select a customer to view reports.</div>
        ) : (
          <div className="space-y-6">
            {/* Submissions */}
            <Section title="Submissions" exportHref={`?${baseParams({ exportSection: 'submissions', format: 'csv' })}`}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                {Object.entries(submissions.countsByStatus).map(([k, v]) => (
                  <Stat key={k} label={k} value={String(v)} />
                ))}
              </div>
              <SimpleTable
                columns={[
                  { k: 'title', l: 'Title' },
                  { k: 'status', l: 'Status' },
                  { k: 'purpose', l: 'Purpose' },
                  { k: 'recipient', l: 'Recipient' },
                  { k: 'providerNpi', l: 'NPI' },
                  { k: 'authorType', l: 'Author' },
                  { k: 'autoSplit', l: 'Auto Split' },
                  { k: 'claimId', l: 'Claim ID' },
                  { k: 'caseId', l: 'Case ID' },
                  { k: 'sendInX12', l: 'X12' },
                  { k: 'threshold', l: 'Threshold' },
                  { k: 'docCount', l: 'Docs' },
                  { k: 'createdAt', l: 'Created' },
                ]}
                rows={submissions.rows}
              />
              <SectionPager page={submissionsPage} hasMore={submissions.hasMore} param="submissionsPage" makeParams={baseParams} label="Submissions" />
            </Section>

            {/* Letters */}
            <Section title="Letters" exportHref={`?${baseParams({ exportSection: 'letters', format: 'csv' })}`}>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <Stat label="Prepay" value={String(letters.counts.PREPAY)} />
                <Stat label="Postpay" value={String(letters.counts.POSTPAY)} />
                <Stat label="Other Postpay" value={String(letters.counts.POSTPAY_OTHER)} />
              </div>
              <SimpleTable
                columns={[{ k: 'type', l: 'Type' }, { k: 'externalLetterId', l: 'External ID' }, { k: 'providerNpi', l: 'NPI' }, { k: 'letterDate', l: 'Letter Date' }, { k: 'respondBy', l: 'Respond By' }]}
                rows={letters.rows}
              />
            </Section>

            {/* eMDR */}
            <Section title="eMDR" exportHref={`?${baseParams({ exportSection: 'emdr', format: 'csv' })}`}>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <Stat label="Providers" value={String(emdr.counts.totalProviders)} />
                <Stat label="Registered" value={String(emdr.counts.registered)} />
                <Stat label="Electronic Only" value={String(emdr.counts.electronicOnly)} />
              </div>
              <SimpleTable
                columns={[{ k: 'npi', l: 'NPI' }, { k: 'name', l: 'Name' }, { k: 'registered', l: 'Registered' }, { k: 'electronicOnly', l: 'E-Only' }, { k: 'regStatus', l: 'Reg Status' }, { k: 'listStage', l: 'Stage' }]}
                rows={emdr.rows}
              />
            </Section>

            {/* NPIs */}
            <Section title="NPIs" exportHref={`?${baseParams({ exportSection: 'npis', format: 'csv' })}`}>
              <div className="grid grid-cols-4 gap-3 mb-3">
                <Stat label="Total" value={String(npis.counts.total)} />
                <Stat label="Active" value={String(npis.counts.active)} />
                <Stat label="Inactive" value={String(npis.counts.inactive)} />
                <Stat label="Ungrouped" value={String(npis.counts.ungrouped)} />
              </div>
              <SimpleTable
                columns={[{ k: 'npi', l: 'NPI' }, { k: 'name', l: 'Name' }, { k: 'active', l: 'Active' }, { k: 'providerGroup', l: 'Group' }, { k: 'assignedUsers', l: 'Users' }, { k: 'submissions', l: 'Submissions' }]}
                rows={npis.rows}
              />
              <SectionPager page={npisPage} hasMore={npis.hasMore} param="npisPage" makeParams={baseParams} label="NPIs" />
            </Section>

            {/* Security */}
            <Section title="Security & Audit" exportHref={`?${baseParams({ exportSection: 'security', format: 'csv' })}`}>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Security Events</h4>
                  <SimpleTable columns={[{ k: 'createdAt', l: 'When' }, { k: 'kind', l: 'Kind' }, { k: 'success', l: 'OK' }, { k: 'userEmail', l: 'User' }, { k: 'ip', l: 'IP' }]} rows={security.security} />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Audit Events</h4>
                  <SimpleTable columns={[{ k: 'createdAt', l: 'When' }, { k: 'category', l: 'Category' }, { k: 'action', l: 'Action' }, { k: 'status', l: 'Status' }, { k: 'actor', l: 'Actor' }, { k: 'entityId', l: 'Entity' }]} rows={security.audit} />
                </div>
              </div>
              <SectionPager page={securityPage} hasMore={security.hasMore} param="securityPage" makeParams={baseParams} label="Security" />
            </Section>

            {/* Document Uploads */}
            <Section title="Document Uploads" exportHref={`?${baseParams({ exportSection: 'doc-uploads', format: 'csv' })}`}>
              <div className="grid grid-cols-5 gap-3 mb-3">
                <Stat label="Total" value={String(docUploads.summary.total || 0)} />
                <Stat label="Uploaded" value={String(docUploads.summary.uploaded || 0)} />
                <Stat label="Pending" value={String(docUploads.summary.pending || 0)} />
                <Stat label="Uploading" value={String(docUploads.summary.uploading || 0)} />
                <Stat label="Failed" value={String(docUploads.summary.failed || 0)} />
              </div>
              <SimpleTable columns={[
                { k: 'createdAt', l: 'When' },
                { k: 'submissionId', l: 'Submission' },
                { k: 'submissionTitle', l: 'Title' },
                { k: 'providerNpi', l: 'NPI' },
                { k: 'uploader', l: 'Uploader' },
                { k: 'originalFileName', l: 'Original Name' },
                { k: 'fileSize', l: 'Size' },
                { k: 'status', l: 'Status' },
              ]} rows={docUploads.rows} />
              {docUploads.failures?.length ? (
                <div className="mt-4">
                  <h4 className="text-sm font-semibold text-red-700 mb-2">Failures</h4>
                  <SimpleTable columns={[
                    { k: 'createdAt', l: 'When' },
                    { k: 'submissionId', l: 'Submission' },
                    { k: 'originalFileName', l: 'File' },
                    { k: 'uploader', l: 'Uploader' },
                    { k: 'status', l: 'Status' },
                  ]} rows={docUploads.failures} />
                </div>
              ) : null}
              <SectionPager page={uploadsPage} hasMore={docUploads.hasMore} param="uploadsPage" makeParams={baseParams} label="Uploads" />
            </Section>

            {/* Security Anomalies */}
            <Section title="Security Anomalies" exportHref={`?${baseParams({ exportSection: 'security-anomalies', format: 'csv' })}`}>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <Stat label="Security Events" value={String(anomalies.counts.security)} />
                <Stat label="Audit Events" value={String(anomalies.counts.audit)} />
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Security</h4>
                  <SimpleTable columns={[{ k: 'createdAt', l: 'When' }, { k: 'kind', l: 'Kind' }, { k: 'success', l: 'OK' }, { k: 'user', l: 'User' }, { k: 'ip', l: 'IP' }, { k: 'reason', l: 'Reason' }]} rows={anomalies.rows.security} />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-gray-700 mb-2">Audit</h4>
                  <SimpleTable columns={[{ k: 'createdAt', l: 'When' }, { k: 'category', l: 'Category' }, { k: 'action', l: 'Action' }, { k: 'status', l: 'Status' }, { k: 'actor', l: 'Actor' }, { k: 'message', l: 'Message' }]} rows={anomalies.rows.audit} />
                </div>
              </div>
              <SectionPager page={anomaliesPage} hasMore={anomalies.hasMore} param="anomaliesPage" makeParams={baseParams} label="Anomalies" />
            </Section>

            {/* Compliance */}
            <Section title="Compliance" exportHref={`?${baseParams({ exportSection: 'compliance', format: 'csv' })}`}>
              <div className="grid grid-cols-5 gap-3 mb-3">
                <Stat label="BAA Number" value={String(compliance.summary.baaNumber || '—')} />
                <Stat label="BAA Date" value={String(compliance.summary.baaDate || '—')} />
                <Stat label="Users" value={String(compliance.summary.totalUsers || 0)} />
                <Stat label="2FA Enabled" value={String(compliance.summary.twoFactorEnabled || 0)} />
                <Stat label="Must Change PW" value={String(compliance.summary.mustChangePassword || 0)} />
              </div>
              <SimpleTable columns={[{ k: 'name', l: 'Name' }, { k: 'email', l: 'Email' }, { k: 'twoFactorEnabled', l: '2FA' }, { k: 'mustChangePassword', l: 'Must Change' }, { k: 'active', l: 'Active' }]} rows={compliance.rows} />
            </Section>
            <div className="text-[10px] text-gray-400 pt-4 text-center">End of report sections • Page size 250 per section • Use individual pagers above.</div>
          </div>
        )}
      </div>
    </InterexLayout>
  )
}

function Section(props: { title: string; exportHref?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white shadow rounded-md">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">{props.title}</h3>
        {props.exportHref ? (
          <a href={props.exportHref} className="text-xs text-blue-600 hover:underline" title="Export CSV">Export CSV</a>
        ) : null}
      </div>
      <div className="p-4">{props.children}</div>
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded p-3">
      <div className="text-[11px] text-gray-500">{props.label}</div>
      <div className="text-lg font-semibold text-gray-800">{props.value}</div>
    </div>
  )
}

function SimpleTable(props: { columns: Array<{ k: string; l: string }>; rows: Array<Record<string, any>> }) {
  const { columns, rows } = props
  return (
    <div className="overflow-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {columns.map(c => (
              <th key={c.k} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{c.l}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 ? (
            <tr><td className="px-3 py-3 text-sm text-gray-500" colSpan={columns.length}>No rows.</td></tr>
          ) : rows.map((r, idx) => (
            <tr key={idx} className="hover:bg-gray-50">
              {columns.map(c => (
                <td key={c.k} className="px-3 py-2 text-[12px] text-gray-800">{formatCell(r[c.k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function formatCell(v: any) {
  if (v === true) return 'Yes'
  if (v === false) return 'No'
  return v ?? ''
}
 
