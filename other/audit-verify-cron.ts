// CLI entrypoint to run the audit integrity job on a schedule (e.g., Fly cron).
import { runAuditIntegrityJob } from '#app/services/audit-integrity-job.server.ts'

async function main() {
  const result = await runAuditIntegrityJob({ sampleLimitPerChain: 500 })
  // Exit non-zero if mismatches found so external scheduler can alert.
  if (result.mismatchedChains > 0) {
    console.error('Audit integrity mismatches detected', JSON.stringify(result))
    process.exit(2)
  } else {
    console.log('Audit integrity OK', JSON.stringify(result))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
