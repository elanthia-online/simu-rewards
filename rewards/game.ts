import * as net from "net"
import type { OTP } from "./eaccess/secure";

interface UseOTPOptions {
  maxAttempts?: number
  timeoutMs?: number
  delayMs?: number
  connectTimeoutMs?: number
  /** aborting stops the current attempt (closing its socket) and any further retries */
  signal?: AbortSignal
}

interface AttemptOptions {
  connectTimeoutMs: number
  timeoutMs: number
  signal?: AbortSignal
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted")
}

// One connection to the game server. Settles exactly once; every exit path
// (reward seen, error, early close, connect/operation timeout, abort) clears
// both timers, removes the abort listener and destroys the socket.
function attemptOTP(otp: OTP, { connectTimeoutMs, timeoutMs, signal }: AttemptOptions): Promise<{message: string}> {
  return new Promise((resolve, reject) => {
    const game = new net.Socket()
    game.setDefaultEncoding("ascii")

    let settled = false
    const onAbort = () => finish(abortReason(signal!))

    const connectTimer = setTimeout(
      () => finish(new Error(`Connection timeout after ${connectTimeoutMs}ms`)),
      connectTimeoutMs,
    )
    const operationTimer = setTimeout(
      () => finish(new Error(`Operation timeout after ${timeoutMs}ms`)),
      timeoutMs,
    )

    function finish(error: Error | null, message?: string) {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(operationTimer)
      signal?.removeEventListener("abort", onAbort)
      game.destroy()
      if (error) reject(error)
      else resolve({ message: message! })
    }

    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })

    game.on("error", (error) => finish(error))
    game.on("close", () => finish(new Error("game server closed the connection before a login reward was seen")))

    game.on("data", (data : Buffer) => {
      const incoming = data.toString()
      //console.log(incoming)
      if (incoming.startsWith("<settingsInfo ")) {
        game.write("<c>\r\n")
        game.write("<c>\r\n")
      }

      if (incoming.includes("You have earned the following reward:")) {
        const m = incoming.match(/You have earned the following reward: (.*)!/)
        return finish(null, m ? m[1] : "claimed login reward")
      }

      if (incoming.includes("consecutive days, you have earned")) {
        const m = incoming.match(/consecutive days, you have earned (.*)(?:!|\.)/)
        return finish(null, m ? m[1] : "claimed login reward")
      }

      if (incoming.includes(`<prompt time=`)) {
        return finish(null, "already claimed")
      }
    })

    game.connect({host: otp.host, port: otp.port}, ()=> {
      clearTimeout(connectTimer)
      //console.log("connected to %s:%s", otp.host, otp.port)
      game.write(otp.key + "\n")
      game.write("/FE:STORMFRONT /VERSION:1.0.1.22 /XML\n")
    })
  })
}

// setTimeout as a promise that is cancelled (and rejects) when `signal` aborts.
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function useOTP (otp : OTP, options: UseOTPOptions = {}) : Promise<{message: string}> {
  const {
    maxAttempts = 3,
    timeoutMs = 60_000,
    delayMs = 5000,
    connectTimeoutMs = 10_000,
    signal,
  } = options

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptOTP(otp, { connectTimeoutMs, timeoutMs, signal })
    } catch (err: any) {
      if (attempt === maxAttempts || signal?.aborted) throw err
      console.warn(`Attempt ${attempt}/${maxAttempts} failed: ${err.message} - retrying in ${delayMs}ms...`)
      await delay(delayMs, signal)
    }
  }

  throw new Error(`Failed after ${maxAttempts} attempts`)
}
