// app/utils/secure-file-vault.ts
// Ephemeral, tab-scoped encrypted storage for Files (PDFs).
// - Encrypts with AES-GCM using a per-tab key kept only in memory.
// - Stores ciphertext in IndexedDB so it survives client navigations / soft reloads.
// - If the tab is hard-reloaded and the key is gone, data is undecryptable.

type StoredMeta = {
    name: string
    type: string
    size: number
}

const DB_NAME = 'secure-file-vault'
const STORE = 'items'

// ---- in-memory, per-tab key ----
let tabKey: CryptoKey | null = null
async function getTabKey() {
    if (tabKey) return tabKey
    const raw = crypto.getRandomValues(new Uint8Array(32)) // 256-bit
    tabKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    return tabKey
}

// ---- tiny IndexedDB helpers ----
function idb() {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}
async function idbPut(key: string, value: unknown) {
    const db = await idb()
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(value as any, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}
async function idbGet<T>(key: string) {
    const db = await idb()
    return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
    })
}
async function idbDel(key: string) {
    const db = await idb()
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

// ---- public API ----
export async function vaultPut(key: string, file: File) {
    const meta: StoredMeta = { name: file.name, type: file.type, size: file.size }
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const buf = await file.arrayBuffer()
    const k = await getTabKey()
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf)
    await idbPut(`${key}:meta`, meta)
    await idbPut(`${key}:iv`, iv)
    await idbPut(`${key}:data`, new Uint8Array(ciphertext))
}

export async function vaultGet(key: string): Promise<File | null> {
    const meta = await idbGet<StoredMeta>(`${key}:meta`)
    const iv = await idbGet<Uint8Array>(`${key}:iv`)
    const data = await idbGet<Uint8Array>(`${key}:data`)
    if (!meta || !iv || !data) return null
    if (!tabKey) return null // tab reloaded: undecryptable → treat as absent
    try {
        const k = await getTabKey()
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            k,
            (data as unknown as Uint8Array).buffer,
        )
        return new File([plaintext], meta.name, { type: meta.type })
    } catch {
        // wrong key / tampered / reloaded: treat as absent
        return null
    }
}

export async function vaultDel(key: string) {
    await Promise.all([idbDel(`${key}:meta`), idbDel(`${key}:iv`), idbDel(`${key}:data`)])
}

// move (atomically enough for our purposes)
export async function vaultMove(fromKey: string, toKey: string) {
    const f = await vaultGet(fromKey)
    if (!f) return
    await vaultPut(toKey, f)
    await vaultDel(fromKey)
}
