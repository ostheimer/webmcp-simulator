import { handleHealthRequest } from '../../proof/server/productionApi.ts'

export default function handler(request: Request): Response {
  return handleHealthRequest(request)
}
