import { handleAnalyzeRequest } from '../../proof/server/productionApi.ts'

export const maxDuration = 60

export default {
  fetch(request: Request): Promise<Response> {
    return handleAnalyzeRequest(request)
  },
}
