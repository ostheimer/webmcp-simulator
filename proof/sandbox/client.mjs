import { request } from 'node:http'

const socketPath = process.env.WEBMCP_WORKER_SOCKET
const capabilityToken = process.env.WEBMCP_SESSION_CAPABILITY
const operation = process.env.WEBMCP_WORKER_OPERATION
const payload = process.env.WEBMCP_WORKER_PAYLOAD || '{}'

if (!socketPath || !capabilityToken || !operation) {
  throw new Error('Worker client configuration is incomplete.')
}

const response = await new Promise((resolve, reject) => {
  const requestHandle = request({
    socketPath,
    path: `/${operation}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Wrapper-Capability': capabilityToken,
    },
  }, (incoming) => {
    const chunks = []
    incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    incoming.on('end', () => resolve({
      status: incoming.statusCode || 500,
      body: Buffer.concat(chunks).toString('utf8'),
    }))
  })
  requestHandle.once('error', reject)
  requestHandle.end(payload)
})

process.stdout.write(JSON.stringify(response))

