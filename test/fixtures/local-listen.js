/**
 * Some sandboxes forbid binding even a loopback port (`listen EPERM`). Tests
 * that need a local HTTP server use `localServerTest` so they skip with a
 * clear reason there instead of failing.
 */
import test from 'node:test'
import net from 'node:net'

async function probe() {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    await new Promise((resolve) => server.close(resolve))
    return false
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      return `cannot listen on 127.0.0.1 here (${error.code}); this test needs a local HTTP server — run outside the sandbox`
    }
    throw error
  }
}

export const LOCAL_LISTEN_SKIP = await probe()

export function localServerTest(name, fn) {
  return test(name, { skip: LOCAL_LISTEN_SKIP }, fn)
}
