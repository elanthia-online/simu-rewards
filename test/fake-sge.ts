// In-memory stand-in for the eAccess (SGE) TLS server at eaccess.play.net:7910.
// Install with installFakeSGE(), which replaces tls.connect for the current test.

import { EventEmitter } from "events"
import * as tls from "tls"
import { spyOn } from "bun:test"

export const MASK = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"

export interface FakeSGEOptions {
  account: string
  password: string
  gameCode: string
  characters: Array<{ slot: string; name: string }>
  gameHost?: string
  gamePort?: number
  gameKey?: string
  /** override the reply to a given client message (by its leading letter); null = never reply */
  overrides?: Record<string, string | null>
  /** deliver each command reply (not the hash key) in pieces of this many bytes, as separate 'data' events */
  chunkSize?: number
  /** called with the fake socket once connected, e.g. to emit 'error' or 'close' */
  onConnect?: (socket: EventEmitter) => void
}

export interface FakeSGE {
  /** everything the client wrote, decoded as latin1 */
  received: string[]
  /** exceptions thrown by the client's 'data' handler (a real socket would crash the process) */
  listenerErrors: unknown[]
  /** await a call against this server; rejects if the client's 'data' handler throws */
  run: <T>(call: Promise<T>) => Promise<T>
  connectOptions: tls.ConnectionOptions[]
  destroyed: () => boolean
}

// The eAccess "hash": each byte is ((mask ^ (char - 32)) + 32). Decoding here is
// implemented independently of secure.ts so the test checks the real algorithm.
function unmask(hashed: Buffer) {
  return [...hashed].map((b, i) => String.fromCharCode(((b - 32) ^ MASK.charCodeAt(i)) + 32)).join("")
}

export function installFakeSGE(opts: FakeSGEOptions): FakeSGE {
  let failRun: (error: unknown) => void = () => {}
  const listenerFailure = new Promise<never>((_, reject) => { failRun = reject })
  listenerFailure.catch(() => {})

  const state: FakeSGE & { _destroyed: boolean } = {
    run: call => Promise.race([call, listenerFailure]),
    received: [],
    listenerErrors: [],
    connectOptions: [],
    _destroyed: false,
    destroyed: () => state._destroyed,
  }

  spyOn(tls, "connect").mockImplementation(((connectOpts: tls.ConnectionOptions, onConnect: () => void) => {
    state.connectOptions.push(connectOpts)
    const sock = new EventEmitter() as EventEmitter & { write: Function; destroy: Function }

    const emitData = (piece: string) => {
      try {
        sock.emit("data", Buffer.from(piece, "latin1"))
      } catch (error) {
        // Surface it as a test failure instead of an uncaught exception, which
        // would otherwise leave the awaited promise pending forever.
        state.listenerErrors.push(error)
        failRun(error)
      }
    }
    // `whole` replies are never split: the client reads the hash key as one raw chunk
    const reply = (text: string | null, whole = false) => {
      if (text === null) return
      const size = whole ? text.length : opts.chunkSize ?? text.length
      const pieces = text.length ? text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))! : [""]
      // one event-loop turn per piece, so each arrives as its own 'data' event
      pieces.reduce((after, piece) => after.then(() => new Promise<void>(r => setTimeout(() => { emitData(piece); r() }, 0))), Promise.resolve())
    }

    sock.destroy = () => {
      if (state._destroyed) return
      state._destroyed = true
      setTimeout(() => sock.emit("close"), 0)
    }
    sock.write = (data: string | Buffer) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1")
      const msg = buf.toString("latin1")
      state.received.push(msg)

      if (state._destroyed) return false
      const override = opts.overrides?.[msg[0]]
      if (override !== undefined) return reply(override), true

      if (msg === "K") return reply(MASK, true), true
      if (msg.startsWith("A\t")) {
        const [, account, ...rest] = msg.split("\t")
        const password = unmask(Buffer.from(rest.join("\t"), "latin1"))
        if (account !== opts.account || password !== opts.password) return reply("A\t\tPASSWORD\n"), true
        return reply(`A\t${account.toUpperCase()}\tKEY\t0123456789abcdef\tTest Account\n`), true
      }
      if (msg === "M") return reply(`M\t${opts.gameCode}\tTest Game\n`), true
      if (msg === `N\t${opts.gameCode}\n`) return reply("N\tPRODUCTION|STORM\n"), true
      if (msg === `G\t${opts.gameCode}\n`) return reply("G\tTest Game\t0\t1\n"), true
      if (msg === "C\n") {
        const n = opts.characters.length
        const pairs = opts.characters.flatMap(c => [c.slot, c.name]).join("\t")
        return reply(`C\t${n}\t${n}\t0\t0\t${pairs}\n`), true
      }
      if (msg.startsWith("L\t")) {
        const host = opts.gameHost ?? "storm.example.test"
        const port = opts.gamePort ?? 10024
        const key = opts.gameKey ?? "otp-key-123"
        return reply(`L\tOK\tUPPORT=5535\tGAME=STORM\tGAMECODE=${opts.gameCode}\tGAMEHOST=${host}\tGAMEPORT=${port}\tKEY=${key}\n`), true
      }
      return reply("?\n"), true
    }

    setTimeout(() => {
      onConnect()
      opts.onConnect?.(sock)
    }, 0)
    return sock
  }) as any)

  return state
}
