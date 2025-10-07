// OAuth provider callback route deprecated. Any access now redirects to login.
import { redirect } from 'react-router'
export async function loader() {
  throw redirect('/login')
}
export const action = loader
