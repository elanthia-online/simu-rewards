import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as net from "net"
import { useOTP } from "./game"
import { trackTimers } from "../test/setup"

// A local TCP server standing in for the game server. `script` is called with
// everything the client has sent so far, and returns what to send back (if anything).
type Script = (received: string, send: (s: string) => void) => void

const servers: net.Server[] = []
const sockets: net.Socket[] = []

async function startGameServer(script: Script) {
  const received: string[] = []
  let connections = 0
  let closes = 0
  const server = net.createServer(sock => {
    connections++
    sock.on("close", () => closes++)
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
  return {
    otp: { key: "otp-key-123", host: "127.0.0.1", port },
    received: () => received.join(""),
    connections: () => connections,
    /** resolves once every client connection so far has been closed by the client */
    allClosed: async () => {
      for (let i = 0; i < 100 && closes < connections; i++) await new Promise(r => setTimeout(r, 5))
      return closes === connections
    },
  }
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

  test("closes the socket when an attempt times out", async () => {
    const game = await startGameServer(() => {})

    await expect(useOTP(game.otp, { ...fast, timeoutMs: 50 })).rejects.toThrow("Operation timeout after 50ms")
    expect(await game.allClosed()).toBe(true)
  })

  test("closes the socket after a reward is seen", async () => {
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send("You have earned the following reward: 50 silvers!\r\n")
    })

    await useOTP(game.otp, fast)
    expect(await game.allClosed()).toBe(true)
  })

  test("rejects (and retries) when the server hangs up before a reward", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const game = await startGameServer((buf) => {
      if (buf === handshake) sockets.at(-1)!.end()
    })

    await expect(useOTP(game.otp, { ...fast, maxAttempts: 2 })).rejects.toThrow(
      "game server closed the connection before a login reward was seen",
    )
    expect(game.connections()).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test("an abort signal stops the attempt and closes the socket", async () => {
    const game = await startGameServer(() => {})
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("caller gave up")), 30)

    await expect(useOTP(game.otp, { ...fast, signal: controller.signal })).rejects.toThrow("caller gave up")
    expect(await game.allClosed()).toBe(true)
  })

  test("an abort during the retry delay stops further attempts", async () => {
    spyOn(console, "warn").mockImplementation(() => {})
    const game = await startGameServer((buf) => {
      if (buf === handshake) sockets.at(-1)!.end()
    })
    const controller = new AbortController()

    const started = performance.now()
    const result = useOTP(game.otp, { ...fast, maxAttempts: 3, delayMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(new Error("caller gave up")), 50)

    await expect(result).rejects.toThrow("caller gave up")
    expect(performance.now() - started).toBeLessThan(2000)
    expect(game.connections()).toBe(1)
  })

  test("an already-aborted signal never connects", async () => {
    const game = await startGameServer(() => {})

    await expect(
      useOTP(game.otp, { ...fast, signal: AbortSignal.abort(new Error("already cancelled")) }),
    ).rejects.toThrow("already cancelled")
    await new Promise(r => setTimeout(r, 20))
    expect(game.connections()).toBe(0)
  })

  test("clears its connect and operation timers after a reward", async () => {
    const operation = await trackTimers(4321)
    const game = await startGameServer((buf, send) => {
      if (buf === handshake) send("You have earned the following reward: 50 silvers!\r\n")
    })

    await useOTP(game.otp, { ...fast, timeoutMs: 4321 })

    expect(operation.created()).toBe(1)
    expect(operation.allCleared()).toBe(true)
  })

  test("clears its connect and operation timers when the connection fails", async () => {
    spyOn(console, "warn").mockImplementation(() => {})
    const timers = await trackTimers(4321, 4322)
    const closed = net.createServer()
    await new Promise<void>(r => closed.listen(0, "127.0.0.1", r))
    const { port } = closed.address() as net.AddressInfo
    await new Promise(r => closed.close(r))

    await expect(
      useOTP({ key: "k", host: "127.0.0.1", port }, { ...fast, timeoutMs: 4321, connectTimeoutMs: 4322 }),
    ).rejects.toThrow()

    expect(timers.created()).toBe(2)
    expect(timers.allCleared()).toBe(true)
  })
})
