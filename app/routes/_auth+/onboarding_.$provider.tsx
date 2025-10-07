// Deprecated provider onboarding UI route placeholder.
export default function RemovedProviderOnboarding() {
  return (
    <div className="container pt-20 pb-32 flex flex-col items-center justify-center">
      <h1 className="text-h2">Provider onboarding removed</h1>
      <p className="text-body-md text-muted-foreground mt-4 max-w-prose text-center">
        OAuth / external provider signup flows have been removed from the application scope.
      </p>
    </div>
  )
}

export const loader = async () => ({ removed: true })
export const action = async () => ({ removed: true })
