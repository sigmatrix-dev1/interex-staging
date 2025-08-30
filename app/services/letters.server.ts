// app/services/letters.server.ts
import { prisma } from '#app/utils/db.server.ts'
import {
    pcgListPrePayLetters,
    pcgListPostPayLetters,
    pcgListPostPayOtherLetters,
    pcgDownloadEmdrLetterFile,
} from '#app/services/pcg-hih.server.ts'

function normalizeNpi(raw?: string | null): string | null {
    if (!raw) return null
    const ten = raw.match(/\b\d{10}\b/)
    if (ten) return ten[0]
    const last10 = raw.replace(/\D/g, '').slice(-10)
    return last10.length === 10 ? last10 : null
}

function parseDateSafe(x?: string | null): Date | null {
    if (!x) return null
    const s = x.trim()
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
        const [mm, dd, yyyy] = s.split('/').map(Number)
        return new Date(Date.UTC(yyyy, mm - 1, dd))
    }
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
}

async function findProviderByNpi(npi: string) {
    return prisma.provider.findFirst({
        where: { npi },
        select: { id: true, customerId: true, providerGroupId: true },
    })
}

type DateRange = { startDate: string; endDate: string }

async function fetchAllPages<T>(
    fetcher: (page: number) => Promise<{ items: T[]; total: number }>
): Promise<T[]> {
    const first = await fetcher(1)
    const items = [...first.items]
    const count = first.total || first.items.length
    const pageSize = first.items.length || 100
    const pages = Math.max(1, Math.ceil(count / pageSize))
    for (let p = 2; p <= pages; p++) {
        const next = await fetcher(p)
        items.push(...next.items)
    }
    return items
}

// ----------------- PREPAY -----------------
function extractPrepayFields(x: any) {
    const providerNpi =
        normalizeNpi(x?.eMDRMetaData?.providerDetails?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.claimDetails?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.provider?.npi) ??
        'UNKNOWN'

    const externalLetterId =
        String(x?.letterID ?? x?.eMDRMetaData?.uniqueLetterId ?? x?.eMDRMetaData?.uniqueLetterID ?? '')

    const downloadId = String(x?.eMDRPrePayID ?? x?.letterID ?? '')

    return {
        providerNpi,
        externalLetterId,
        downloadId: downloadId || null,
        esmdTransactionId: x?.esMDTransactionID ?? null,
        hihDeliveryAt: parseDateSafe(x?.eMDRHIHDeliveryTimeStamp),
        letterDate: parseDateSafe(x?.eMDRMetaData?.letterDate),
        respondBy:
            parseDateSafe(x?.eMDRMetaData?.respondBy) ??
            parseDateSafe(x?.eMDRMetaData?.letterDetails?.respondBy),
        jurisdiction: x?.eMDRMetaData?.letterDetails?.jurisdiction ?? null,
        programName: x?.eMDRMetaData?.letterDetails?.programName ?? null,
        stage: x?.stage ?? x?.eMDRMetaData?.stage ?? null,
        language: x?.letterLang ?? null,
        bSendAck: x?.bSendack ?? null,
        ackUniqueId: x?.ackUniqueID ?? null,
        rcOid: x?.rcOID ?? null,
        letterName: x?.letterName ?? null,
    }
}

async function upsertPrepay(x: any) {
    const f = extractPrepayFields(x)
    if (!f.externalLetterId) return

    const prov = f.providerNpi !== 'UNKNOWN' ? await findProviderByNpi(f.providerNpi) : null

    await prisma.prepayLetter.upsert({
        where: { externalLetterId: f.externalLetterId },
        create: {
            externalLetterId: f.externalLetterId,
            downloadId: f.downloadId,
            providerNpi: f.providerNpi,
            providerId: prov?.id ?? null,
            customerId: prov?.customerId ?? null,
            providerGroupId: prov?.providerGroupId ?? null,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
        update: {
            downloadId: f.downloadId ?? undefined,
            providerId: prov?.id ?? undefined,
            customerId: prov?.customerId ?? undefined,
            providerGroupId: prov?.providerGroupId ?? undefined,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
    })
}

// ----------------- POSTPAY -----------------
function extractPostpayFields(x: any) {
    const providerNpi =
        normalizeNpi(x?.eMDRMetaData?.providerDetails?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.claimDetails?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.provider?.npi) ??
        'UNKNOWN'

    const externalLetterId =
        String(x?.letterID ?? x?.eMDRMetaData?.uniqueLetterId ?? x?.eMDRMetaData?.uniqueLetterID ?? '')

    const downloadId = String(x?.eMDRPostPayID ?? x?.letterID ?? '')

    return {
        providerNpi,
        externalLetterId,
        downloadId: downloadId || null,
        esmdTransactionId: x?.esMDTransactionID ?? null,
        hihDeliveryAt: parseDateSafe(x?.eMDRHIHDeliveryTimeStamp),
        letterDate: parseDateSafe(x?.eMDRMetaData?.letterDate),
        respondBy:
            parseDateSafe(x?.eMDRMetaData?.respondBy) ??
            parseDateSafe(x?.eMDRMetaData?.respondByDate),
        jurisdiction: x?.eMDRMetaData?.letterDetails?.jurisdiction ?? x?.eMDRMetaData?.jurisdiction ?? null,
        programName: x?.eMDRMetaData?.letterDetails?.programName ?? x?.eMDRMetaData?.programName ?? null,
        stage: x?.stage ?? x?.eMDRMetaData?.stage ?? null,
        language: x?.letterLang ?? null,
        bSendAck: x?.bSendack ?? null,
        ackUniqueId: x?.ackUniqueID ?? null,
        rcOid: x?.rcOID ?? null,
        letterName: x?.letterName ?? null,
    }
}

async function upsertPostpay(x: any) {
    const f = extractPostpayFields(x)
    if (!f.externalLetterId) return

    const prov = f.providerNpi !== 'UNKNOWN' ? await findProviderByNpi(f.providerNpi) : null

    await prisma.postpayLetter.upsert({
        where: { externalLetterId: f.externalLetterId },
        create: {
            externalLetterId: f.externalLetterId,
            downloadId: f.downloadId,
            providerNpi: f.providerNpi,
            providerId: prov?.id ?? null,
            customerId: prov?.customerId ?? null,
            providerGroupId: prov?.providerGroupId ?? null,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
        update: {
            downloadId: f.downloadId ?? undefined,
            providerId: prov?.id ?? undefined,
            customerId: prov?.customerId ?? undefined,
            providerGroupId: prov?.providerGroupId ?? undefined,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
    })
}

// ------------- POSTPAY (OTHER) -------------
function extractPostpayOtherFields(x: any) {
    const providerNpi =
        normalizeNpi(x?.eMDRMetaData?.provider?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.providerDetails?.npi) ??
        normalizeNpi(x?.eMDRMetaData?.claimDetails?.npi) ??
        'UNKNOWN'

    const externalLetterId =
        String(x?.letterID ?? x?.eMDRMetaData?.uniqueLetterID ?? x?.eMDRMetaData?.uniqueLetterId ?? '')

    const downloadId = String(x?.otherPostPayEMDRId ?? x?.letterID ?? '')

    // Dates in this endpoint are often "MM/DD/YYYY"
    const letterDate = parseDateSafe(x?.eMDRMetaData?.letterDate)
    const respondBy =
        parseDateSafe(x?.eMDRMetaData?.respondByDate) ??
        parseDateSafe(x?.eMDRMetaData?.respondBy)

    return {
        providerNpi,
        externalLetterId,
        downloadId: downloadId || null,
        esmdTransactionId: x?.esMDTransactionID ?? null,
        hihDeliveryAt: parseDateSafe(x?.eMDRHIHDeliveryTimeStamp),
        letterDate,
        respondBy,
        jurisdiction: x?.eMDRMetaData?.jurisdiction ?? null,
        programName: x?.eMDRMetaData?.programName ?? null,
        stage: x?.stage ?? x?.eMDRMetaData?.stage ?? null,
        language: x?.letterLang ?? null,
        bSendAck: x?.bSendack ?? null,
        ackUniqueId: x?.ackUniqueID ?? null,
        rcOid: x?.eMDRMetaData?.rcSystemIdentifier ?? x?.rcOID ?? null,
        letterName: x?.letterName ?? null,
    }
}

async function upsertPostpayOther(x: any) {
    const f = extractPostpayOtherFields(x)
    if (!f.externalLetterId) return

    const prov = f.providerNpi !== 'UNKNOWN' ? await findProviderByNpi(f.providerNpi) : null

    await prisma.postpayOtherLetter.upsert({
        where: { externalLetterId: f.externalLetterId },
        create: {
            externalLetterId: f.externalLetterId,
            downloadId: f.downloadId,
            providerNpi: f.providerNpi,
            providerId: prov?.id ?? null,
            customerId: prov?.customerId ?? null,
            providerGroupId: prov?.providerGroupId ?? null,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
        update: {
            downloadId: f.downloadId ?? undefined,
            providerId: prov?.id ?? undefined,
            customerId: prov?.customerId ?? undefined,
            providerGroupId: prov?.providerGroupId ?? undefined,
            esmdTransactionId: f.esmdTransactionId,
            hihDeliveryAt: f.hihDeliveryAt ?? undefined,
            letterDate: f.letterDate ?? undefined,
            respondBy: f.respondBy ?? undefined,
            jurisdiction: f.jurisdiction,
            programName: f.programName,
            stage: f.stage,
            language: f.language,
            bSendAck: f.bSendAck,
            ackUniqueId: f.ackUniqueId,
            rcOid: f.rcOid,
            letterName: f.letterName,
            raw: x,
        },
    })
}

// ----------------- SYNC -----------------

export async function syncLetters(params: { startDate: string; endDate: string; types?: Array<'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'> }) {
    const types = params.types?.length ? params.types : (['PREPAY', 'POSTPAY', 'POSTPAY_OTHER'] as const)

    let count = 0

    if (types.includes('PREPAY')) {
        const items = await fetchAllPages(async page => {
            const r = await pcgListPrePayLetters({ page, startDate: params.startDate, endDate: params.endDate })
            const list = r.prepayeMDRList ?? []
            return { items: list, total: r.totalResultCount ?? list.length }
        })
        for (const x of items) {
            await upsertPrepay(x)
            count++
        }
    }

    if (types.includes('POSTPAY')) {
        const items = await fetchAllPages(async page => {
            const r = await pcgListPostPayLetters({ page, startDate: params.startDate, endDate: params.endDate })
            const list = (r.postpayeMDRList ?? r.postPayeMDRList ?? []) as any[]
            return { items: list, total: r.totalResultCount ?? list.length }
        })
        for (const x of items) {
            await upsertPostpay(x)
            count++
        }
    }

    if (types.includes('POSTPAY_OTHER')) {
        const items = await fetchAllPages(async page => {
            const r = await pcgListPostPayOtherLetters({ page, startDate: params.startDate, endDate: params.endDate })
            const list = r.otherPostPayEMDRList ?? []
            return { items: list, total: r.totalResultCount ?? list.length }
        })
        for (const x of items) {
            await upsertPostpayOther(x)
            count++
        }
    }

    return { upserted: count }
}

// ----------------- DOWNLOAD -----------------

export async function downloadLetterPdf(args: { type: 'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'; externalLetterId: string }) {
    // find the record to determine the correct downloadId (PCG is inconsistent)
    if (args.type === 'PREPAY') {
        const row = await prisma.prepayLetter.findUnique({ where: { externalLetterId: args.externalLetterId } })
        if (!row) throw new Error('Letter not found')
        const letter_id = row.downloadId ?? row.externalLetterId
        const r = await pcgDownloadEmdrLetterFile({ letter_id, letter_type: 'PREPAY' })
        return { fileBase64: r.file_content, filename: `PREPAY-${args.externalLetterId}.pdf` }
    }

    if (args.type === 'POSTPAY') {
        const row = await prisma.postpayLetter.findUnique({ where: { externalLetterId: args.externalLetterId } })
        if (!row) throw new Error('Letter not found')
        const letter_id = row.downloadId ?? row.externalLetterId
        const r = await pcgDownloadEmdrLetterFile({ letter_id, letter_type: 'POSTPAY' })
        return { fileBase64: r.file_content, filename: `POSTPAY-${args.externalLetterId}.pdf` }
    }

    // POSTPAY_OTHER
    const row = await prisma.postpayOtherLetter.findUnique({ where: { externalLetterId: args.externalLetterId } })
    if (!row) throw new Error('Letter not found')
    const letter_id = row.downloadId ?? row.externalLetterId
    const r = await pcgDownloadEmdrLetterFile({ letter_id, letter_type: 'POSTPAY_OTHER' })
    return { fileBase64: r.file_content, filename: `POSTPAY_OTHER-${args.externalLetterId}.pdf` }
}
