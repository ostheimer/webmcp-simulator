import { handleCloseRequest } from '../../proof/server/productionApi.ts'

export const maxDuration = 15

export default function handler(request: Request): Promise<Response> {
  return handleCloseRequest(request)
}

