import { handleHealthRequest } from '../../proof/server/productionApi.ts'

export default {
  fetch(request: Request): Response {
    return handleHealthRequest(request)
  },
}
