// Client-only encrypted file vault using IndexedDB + Web Crypto (AES-GCM).
// Stores Files as encrypted blobs keyed by a string. Key material lives only
// in sessionStorage (per-tab) and never leaves the browser.

const DB_NAME = 'esmd-vault'
const STORE = 'files'
const VERSION = 1

type StoredRecord = {
    iv: ArrayBuffer
    bytes: ArrayBuffer
    type: string
    name: string
    lastModified: number
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

function idbReq<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
    })
}

function safeCommit(tx: IDBTransaction) {
    // Some browsers expose tx.commit(), some don't. Also avoid typing issues.
    try {
        ;(tx as any).commit?.()
    } catch {
        // no-op; normal auto-commit still applies
    }
}

// ---- crypto helpers ----
const SS_KEY = 'esmdVaultKey.v1'

function bufToB64(buf: ArrayBuffer) {
    const bytes = new Uint8Array(buf)
    let str = ''
    for (let i = 0; i < bytes.length; i++) {
        // With noUncheckedIndexedAccess, bytes[i] is number | undefined.
        // We know it's in-bounds due to the loop condition.
        str += String.fromCharCode(bytes[i]!)
    }
    return btoa(str)
}
function b64ToBuf(b64: string) {
    const str = atob(b64)
    const bytes = new Uint8Array(str.length)
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i)
    return bytes.buffer
}

async function getKey(): Promise<CryptoKey> {
    let raw = sessionStorage.getItem(SS_KEY)
    if (!raw) {
        const rand = crypto.getRandomValues(new Uint8Array(32))
        sessionStorage.setItem(SS_KEY, bufToB64(rand.buffer))
        raw = sessionStorage.getItem(SS_KEY)!
    }
    const keyBytes = b64ToBuf(raw)
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encrypt(plain: ArrayBuffer) {
    const key = await getKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
    return { iv: iv.buffer, bytes }
}
async function decrypt(iv: ArrayBuffer, bytes: ArrayBuffer) {
    const key = await getKey()
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, bytes)
    return plain
}

// ---- public API ----
export async function vaultPut(key: string, file: File): Promise<void> {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const plain = await file.arrayBuffer()
    const { iv, bytes } = await encrypt(plain)
    const rec: StoredRecord = {
        iv,
        bytes,
        type: file.type,
        name: file.name,
        lastModified: Number(file.lastModified ?? Date.now()),
    }
    await idbReq(store.put(rec, key))
    safeCommit(tx)
    db.close()
}

export async function vaultGet(key: string): Promise<File | null> {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const rec = (await idbReq(store.get(key))) as StoredRecord | undefined
    safeCommit(tx)
    db.close()
    if (!rec) return null
    const plain = await decrypt(rec.iv, rec.bytes)
    return new File([plain], rec.name, { type: rec.type, lastModified: Number(rec.lastModified ?? Date.now()) })
}

export async function vaultDel(key: string): Promise<void> {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    await idbReq(store.delete(key))
    safeCommit(tx)
    db.close()
}

export async function vaultMove(fromKey: string, toKey: string): Promise<void> {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const rec = (await idbReq(store.get(fromKey))) as StoredRecord | undefined
    if (rec) {
        await idbReq(store.put(rec, toKey))
        await idbReq(store.delete(fromKey))
    }
    safeCommit(tx)
    db.close()
}

export async function vaultListKeys(prefix?: string): Promise<string[]> {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const keys = (await idbReq(store.getAllKeys())) as IDBValidKey[]
    safeCommit(tx)
    db.close()
    const asStrings = keys.map(k => String(k))
    return prefix ? asStrings.filter(k => k.startsWith(prefix)) : asStrings
}
