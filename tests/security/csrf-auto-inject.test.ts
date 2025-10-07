// Minimal jsdom import (dev dependency expected present in test env). If types missing, fallback declare below.
import { JSDOM } from 'jsdom'
import { describe, it, expect } from 'vitest'

// This test exercises the CSRF auto-inject script logic in isolation by simulating DOM operations.
// We replicate the core injection function and ensure dynamic forms get a hidden csrf input.

describe('csrf auto-inject script', () => {
  function runScript(doc: Document, token: string) {
    // Extracted minimal logic mirroring root.tsx inline script
    function inject(f: HTMLFormElement, t: string){
      if(!f||!t)return; if((f as any).__csrfInjected) return;
      if(f.querySelector('input[name=csrf],input[name=_csrf]')){(f as any).__csrfInjected=true;return;}
      const i = doc.createElement('input'); i.type='hidden'; i.name='csrf'; i.value=t; f.appendChild(i); (f as any).__csrfInjected=true;
    }
    function scan(t:string){ const forms = doc.querySelectorAll('form[method=post],form[method=POST]'); forms.forEach(f=>inject(f as HTMLFormElement,t)) }
    scan(token)
    const mo = new (doc.defaultView!.MutationObserver)(muts => {
      muts.forEach(rec => {
        rec.addedNodes.forEach(node => {
          if(!(node instanceof doc.defaultView!.HTMLElement)) return
          if(node.tagName==='FORM') {
            const mth=(node.getAttribute('method')||'').toLowerCase(); if(mth==='post') inject(node as HTMLFormElement, token)
          }
          node.querySelectorAll?.('form').forEach(nf => { const mth=(nf.getAttribute('method')||'').toLowerCase(); if(mth==='post') inject(nf as HTMLFormElement, token) })
        })
      })
    })
    mo.observe(doc.documentElement,{childList:true,subtree:true})
  }

  function makeDoc() {
    // Use JSDOM explicitly to avoid relying on global test env
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
    return dom.window.document
  }

  it('injects into existing POST forms and ignores GET', () => {
    const doc = makeDoc()
    doc.body.innerHTML = `<form id="f1" method="post"></form><form id="f2" method="get"></form>`
    runScript(doc,'TOK')
    const f1 = doc.getElementById('f1') as HTMLFormElement
    const f2 = doc.getElementById('f2') as HTMLFormElement
    expect(f1.querySelector('input[name=csrf]')?.getAttribute('value')).toBe('TOK')
    expect(f2.querySelector('input[name=csrf]')).toBeNull()
  })

  it('injects into dynamically added forms', async () => {
    const doc = makeDoc()
    runScript(doc,'TOK2')
    const dyn = doc.createElement('form'); dyn.method='post'; doc.body.appendChild(dyn)
    // MutationObserver is async microtask; queue a tick
    await new Promise(r=>setTimeout(r,10))
    expect(dyn.querySelector('input[name=csrf]')?.getAttribute('value')).toBe('TOK2')
  })

  it('does not duplicate injection', () => {
    const doc = makeDoc()
    doc.body.innerHTML = `<form id="f" method="post"><input type="hidden" name="csrf" value="OLD" /></form>`
    runScript(doc,'NEW')
    const f = doc.getElementById('f') as HTMLFormElement
    const inputs = f.querySelectorAll('input[name=csrf]')
  expect(inputs).toHaveLength(1)
  const first = inputs.item(0)
  expect(first && first.getAttribute('value')).toBe('OLD') // preserved existing
  })
})
