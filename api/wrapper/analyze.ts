import { handleAnalyzeRequest } from '../../proof/server/productionApi.ts'

export const maxDuration = 60

export default function handler(request: Request): Promise<Response> {
  return handleAnalyzeRequest(request)
}

