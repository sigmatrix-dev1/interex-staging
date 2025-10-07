// Deprecated provider initiation route. Redirect to login.
import { redirect } from 'react-router'
export async function loader() { throw redirect('/login') }
export const action = loader
