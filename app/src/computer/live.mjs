import { spawn } from 'node:child_process'

// A fixed endpoint inside the verified container. Its lifetime follows the exec pipe.
const relay = `import socket, sys, threading
with socket.create_connection(('127.0.0.1', 5901), timeout=5) as desktop:
    desktop.settimeout(None)
    def forward_input():
        try:
            while data := sys.stdin.buffer.read1(65536):
                desktop.sendall(data)
        finally:
            desktop.shutdown(socket.SHUT_RDWR)
    threading.Thread(target=forward_input, daemon=True).start()
    while data := desktop.recv(65536):
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
`

export function openLiveDesktop({ binary, prefix, id, env, port, signal }) {
  signal.throwIfAborted()
  const child = spawn(binary, [...prefix, 'exec', '-i', id, '/opt/venv/bin/python', '-I', '-u', '-c', relay], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  })
  const done = new Promise(resolve => child.once('close', resolve))
  const output = child.stdout[Symbol.asyncIterator]()
  let reading = false
  let closed = false
  function close() {
    if (!closed) {
      closed = true
      signal.removeEventListener('abort', close)
      port.close()
      child.stdin.destroy()
      child.kill()
    }
    return done
  }
  child.once('close', close)
  child.once('error', close)
  child.stdin.on('error', close)
  port.once('close', close)
  signal.addEventListener('abort', close, { once: true })
  port.on('message', async ({ data }) => {
    if (closed) return
    try {
      if (data === 'read' && !reading) {
        reading = true
        const next = await output.next()
        reading = false
        if (next.done) void close()
        else if (!closed) port.postMessage(Uint8Array.from(next.value))
      } else if (data instanceof Uint8Array && data.length > 0 && data.length <= 64 * 1024 && child.stdin.writableLength < 256 * 1024) {
        child.stdin.write(data)
      } else void close()
    } catch { void close() }
  })
  port.start()
  return { close, done }
}
