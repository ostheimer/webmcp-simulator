import { handleCloseRequest } from '../../proof/server/productionApi.ts'

export const maxDuration = 15

export default {
  fetch(request: Request): Promise<Response> {
    return handleCloseRequest(request)
  },
}
