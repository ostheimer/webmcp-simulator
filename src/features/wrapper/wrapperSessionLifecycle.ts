export interface WrapperSessionCredentials {
  sessionId: string
  sessionToken: string
}

export function retireWrapperSessionResources(
  registrationController: AbortController | null,
  credentials: { current: WrapperSessionCredentials | null },
  closeSession: (sessionId: string, sessionToken: string) => void,
): void {
  const activeCredentials = credentials.current
  registrationController?.abort()
  credentials.current = null
  if (activeCredentials) {
    closeSession(activeCredentials.sessionId, activeCredentials.sessionToken)
  }
}
