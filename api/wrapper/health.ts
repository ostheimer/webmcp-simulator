import { handleHealthRequest } from '../../proof/server/productionApi.ts'

export default function handler(): Response {
  return handleHealthRequest()
}

