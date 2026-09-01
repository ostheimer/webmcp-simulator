import { handleActionRequest } from '../../proof/server/productionApi.ts'

export const maxDuration = 30

export default {
  fetch(request: Request): Promise<Response> {
    return handleActionRequest(request)
  },
}
