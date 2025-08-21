// app/utils/file-cache.ts
// Adapter that keeps your existing API but uses the secure vault.

import { vaultPut, vaultGet, vaultDel, vaultMove } from './secure-file-vault'

// keep a tiny in-memory hint to avoid decrypt/IDB hit if we just wrote
const mem = new Map<string, File>()

export async function setCachedFile(key: string, file: File) {
    mem.set(key, file)
    await vaultPut(key, file)
}

export async function getCachedFile(key: string) {
    if (mem.has(key)) return mem.get(key)!
    const f = await vaultGet(key)
    if (f) mem.set(key, f)
    return f
}

export async function clearCachedFile(key: string) {
    mem.delete(key)
    await vaultDel(key)
}

// helper you can use in review step
export async function moveCachedFile(fromKey: string, toKey: string) {
    const f = await getCachedFile(fromKey)
    if (!f) return
    mem.set(toKey, f)
    mem.delete(fromKey)
    await vaultMove(fromKey, toKey)
}
