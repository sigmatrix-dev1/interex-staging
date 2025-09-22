import { redirect } from 'react-router'

export async function loader() {
  throw redirect('/admin/audit-logs')
}

export default function LegacyAuditEventsRedirect() {
  return null
}
