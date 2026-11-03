import * as tls from "tls"
const host = "eaccess.play.net"
const port = 7910

const connectOptions = {host, port, rejectUnauthorized: false}
type CharacterInfo = {
  name: string;
  slot: string;
}

export type OTP = {
  key: string;
  host: string;
  port: number;
}

enum State {
  Starting,
  Handshaking,
  Authenticated,
  Finished,
}

export enum Mode {
  Characters,
  Login,
}

export enum GameCode {
  GS4 = "GS3",
  GST = "GST",
  GSF = "GSF",
  GSX = "GSX",
  DR  = "DR",
  DRT = "DRT",
  DRF = "DRF",
  DRX = "DRX",
}

function hashChar(pwChar : string, hashNum : number) {
  return (hashNum ^ (pwChar.charCodeAt(0) - 32)) + 32;
}

export async function sendAccountDetails (sge :tls.TLSSocket, account : string, password: string, mask: string) {
  if (mask.length < password.length) {
    throw new Error(`malformed hash key from eAccess (${mask.length} bytes for a ${password.length} character password)`)
  }
  const maskedPassword = password.split("").map((char, i) => hashChar(char, mask[i].charCodeAt(0)))

  const auth = Buffer.concat([
    Buffer.from(`A\t${account}\t`),
    Buffer.from(maskedPassword),
  ])
  sge.write(auth, "binary")
}

export function tsv (s : string) {
  return s.trim().split("\t")
}

export function tsvToRecord (list : string[]) : Record<string, string> {
  return Object.fromEntries(list.reduce((acc, v, idx)=>{
    if (idx % 2 == 1) {
      acc[acc.length-1].push(v)
    } else {
      acc.push([v] as any)
    }

    return acc
  }, [] as Array<[string, string]>))
}

export function parseGameList (incoming : string) : Record<string, string> {
  const list = tsv(incoming).slice(1)
  return tsvToRecord(list)
}

export interface SessionOptions {
  /** give up on the whole eAccess exchange after this long (default 30s) */
  timeoutMs?: number
}

interface Session<T> {
  sge: tls.TLSSocket
  resolve: (value: T) => void
  reject: (error: Error) => void
}

// Runs one authenticated eAccess exchange. `onReply` receives each reply after
// the account is authenticated and the game is selected. Each TCP read is one
// reply: eAccess replies are not reliably newline-terminated, so (like lich-5
// and the official launcher) there is no framing beyond that. The returned promise
// settles exactly once; every exit path (result, protocol error, exception in
// a handler, socket error or close, timeout) destroys the socket and clears
// the timers.
function session<T> (
  account : string,
  password : string,
  gameCode : GameCode,
  onReply : (reply : string, session : Session<T>) => void,
  options : SessionOptions = {},
) : Promise<T> {
  const { timeoutMs = 30_000 } = options

  return new Promise<T>((resolve, reject) => {
    let state = State.Starting
    let settled = false
    let timeout : ReturnType<typeof setTimeout> | undefined
    let sge : tls.TLSSocket | undefined

    const finish = (error : Error | null, value? : T) => {
      if (settled) return
      settled = true
      state = State.Finished
      clearTimeout(timeout)
      sge?.destroy()
      if (error) reject(error)
      else resolve(value as T)
    }
    const fail = (err : unknown) => finish(err instanceof Error ? err : new Error(String(err)))

    const handleReply = (raw : string, ctx : Session<T>) => {
      if (state === State.Finished) return
      const reply = raw.trim()

      if (state === State.Handshaking) {
        if (reply.startsWith("A") && reply.includes("\tKEY\t")) {
          state = State.Authenticated
          ctx.sge.write("M")
          return
        }
        if (reply.includes("PASSWORD")) return ctx.reject(new Error(`account:${account} | invalid password`))
        if (reply.startsWith("?")) return ctx.reject(new Error("invalid protocol implementation"))
        // NORECORD, REJECT, PROBLEM, INVALID, ... -- anything else is a failed login
        return ctx.reject(new Error(`account:${account} | login rejected: ${reply || "(empty reply)"}`))
      }

      if (state === State.Authenticated) {
        if (reply.startsWith("M")) return void ctx.sge.write(`N\t${gameCode}\n`)
        if (reply.startsWith("N")) return void ctx.sge.write(`G\t${gameCode}\n`)
        if (reply.startsWith("G")) return void ctx.sge.write("C\n")
        return onReply(reply, ctx)
      }
    }

    try {
      timeout = setTimeout(
        () => fail(new Error(`account:${account} | eAccess timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )

      const socket : tls.TLSSocket = tls.connect({...connectOptions}, () => socket.write("K"))
      sge = socket
      const ctx : Session<T> = {
        sge: socket,
        resolve: value => finish(null, value),
        reject: error => finish(error),
      }

      socket.on("data", (data : Buffer) => {
        try {
          if (state === State.Starting) {
            // the first reply is the hash key used to mask the password
            state = State.Handshaking
            sendAccountDetails(socket, account, password, data.toString()).catch(fail)
            return
          }
          handleReply(data.toString(), ctx)
        } catch (err) {
          fail(err)
        }
      })
      socket.on("error", fail)
      socket.on("close", () => fail(new Error(`account:${account} | eAccess closed the connection before login completed`)))
    } catch (err) {
      fail(err)
    }
  })
}

function parseCharacters (reply : string) : CharacterInfo[] {
  const records = tsvToRecord(tsv(reply).slice(5))
  return Object.entries(records).map(([slot, name]) => ({slot, name}))
}

export async function listCharacters (account : string, password : string, gameCode : GameCode, options? : SessionOptions) : Promise<CharacterInfo[]> {
  return session<CharacterInfo[]>(account, password, gameCode, (reply, {resolve, reject}) => {
    if (reply.startsWith("C")) return resolve(parseCharacters(reply))
    reject(new Error(`Error - unknown text received:\n${reply}`))
  }, options)
}

function launchField (reply : string, field : string) {
  const value = reply.match(new RegExp(`(?:^|\\t)${field}=([^\\t]+)`))?.[1]
  if (!value) throw new Error(`eAccess launch reply is missing ${field}: ${reply}`)
  return value
}

export async function getOTP (account : string, password : string, gameCode : GameCode, requestedCharacter : string, options? : SessionOptions) : Promise<OTP> {
  return session<OTP>(account, password, gameCode, (reply, {sge, resolve, reject}) => {
    if (reply.startsWith("C")) {
      const character = parseCharacters(reply).find(({name}) => name.toLowerCase() == requestedCharacter.toLowerCase())
      if (!character) {
        return reject(new Error(`account ${account} does not have requested character ${requestedCharacter}`))
      }
      return void sge.write(`L\t${character.slot}\tSTORM\n`)
    }

    if (reply.startsWith("L\tOK\t")) {
      const port = parseInt(launchField(reply, "GAMEPORT"), 10)
      if (!Number.isInteger(port)) throw new Error(`eAccess launch reply has an invalid GAMEPORT: ${reply}`)
      return resolve({
        key: launchField(reply, "KEY"),
        host: launchField(reply, "GAMEHOST"),
        port,
      })
    }

    if (reply.startsWith("L")) {
      return reject(new Error(`account:${account} | ${requestedCharacter} could not be launched: ${reply}`))
    }

    reject(new Error(`Error - unknown text received:\n${reply}`))
  }, options)
}
