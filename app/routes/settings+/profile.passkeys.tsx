// Passkey settings route removed. Stub component.
export const handle = { deprecated: true }

export async function loader() {
	throw new Response('Not Found', { status: 404 })
}

export async function action() {
	throw new Response('Not Found', { status: 404 })
}

export default function Passkeys() {
	return <div className="text-muted-foreground">Passkeys feature removed.</div>
}
