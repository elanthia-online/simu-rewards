import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as net from "net"
import { useOTP } from "./game"

// A local TCP server standing in for the game server. `script` is called with
// everything the client has sent so far, and returns what to send back (if anything).
type Script = (received: string, send: (s: string) => void) => void

const servers: net.Server[] = []
const sockets: net.Socket[] = []

async function startGameServer(script: Script) {
  const received: string[] = []
  const server = net.createServer(sock => {
    sockets.push(sock)
    let buf = ""
    sock.on("data", d => {
      buf += d.toString()
      received.push(d.toString())
      script(buf, s => sock.write(s))
    })
    sock.on("error", () => {})
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as net.AddressInfo
  return { otp: { key: "otp-key-123", host: "127.0.0.1", port }, received: () => received.join("") }
}

afterEach(async () => {
  mock.restore()
  sockets.splice(0).forEach(s => s.destroy())
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))))
})

const handshake = "otp-key-123\n/FE:STORMFRONT /VERSION:1.0.1.22 /XML\n"
const fast = { maxAttempts: 1, timeoutMs: 500, connectTimeoutMs: 500, delayMs: 1 }

describe("useOTP", () => {
  test("sends the key and frontend handshake, then parses the login reward", async () => {
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send("You have earned the following reward: 50 silvers!\r\n")
    })

    await expect(useOTP(game.otp, fast)).resolves.toEqual({ message: "50 silvers" })
    expect(game.received()).toBe(handshake)
  })

  test("parses the consecutive-days reward message", async () => {
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send("For logging in 5 consecutive days, you have earned a Bonus Point!\r\n")
    })

    await expect(useOTP(game.otp, fast)).resolves.toEqual({ message: "a Bonus Point" })
  })

  test("answers <settingsInfo> with two <c> lines before the reward arrives", async () => {
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send("<settingsInfo  client='1.0.1.26' major='4' />")
      if (buf === handshake + "<c>\r\n<c>\r\n") send("You have earned the following reward: 1 Simucoin!\r\n")
    })

    await expect(useOTP(game.otp, fast)).resolves.toEqual({ message: "1 Simucoin" })
  })

  test("treats a prompt with no reward as already claimed", async () => {
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send(`<prompt time="1700000000">&gt;</prompt>\r\n`)
    })

    await expect(useOTP(game.otp, fast)).resolves.toEqual({ message: "already claimed" })
  })

  test("times out if the server never sends a recognised message", async () => {
    const game = await startGameServer(() => {})

    await expect(useOTP(game.otp, { ...fast, timeoutMs: 100 })).rejects.toThrow("Operation timeout after 100ms")
  })

  test("retries a refused connection and rethrows the last error", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const closed = net.createServer()
    await new Promise<void>(r => closed.listen(0, "127.0.0.1", r))
    const { port } = closed.address() as net.AddressInfo
    await new Promise(r => closed.close(r))

    await expect(
      useOTP({ key: "k", host: "127.0.0.1", port }, { ...fast, maxAttempts: 2 }),
    ).rejects.toThrow(/ECONNREFUSED|refused/i)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
