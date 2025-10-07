// Minimal jsdom type shim to satisfy TS in test environment without pulling full @types.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, opts?: any)
    window: any
  }
}