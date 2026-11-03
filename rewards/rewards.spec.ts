import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Account, Game, SGE, claim } from "./index"
import { GameCode } from "./eaccess/secure"

const accountOk = { account: "testacct", message: "claimed 500 simucoins!", balance: "600" }
const otp = (name: string) => ({ key: `key-${name}`, host: "127.0.0.1", port: 1 })

const realSetTimeout = globalThis.setTimeout
let savedBypass: string | undefined

beforeEach(() => {
  savedBypass = process.env.BYPASS_LOGIN
  delete process.env.BYPASS_LOGIN
  for (const level of ["log", "warn", "error"] as const) spyOn(console, level).mockImplementation(() => {})
  // claim() waits 500ms between characters and 2s between retries, and races each
  // login against a 60s timeout. Run the short waits immediately and drop the 60s
  // timer so the suite stays fast and leaves nothing pending.
  spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
    (ms ?? 0) >= 60_000 ? realSetTimeout(() => {}, 0) : realSetTimeout(fn, 0)) as any)
})

afterEach(() => {
  mock.restore()
  if (savedBypass === undefined) delete process.env.BYPASS_LOGIN
  else process.env.BYPASS_LOGIN = savedBypass
})

describe("claim input validation", () => {
  test("requires an account", async () => {
    await expect(claim(undefined, "pw", GameCode.GS4)).rejects.toThrow("account was missing")
  })

  test("requires a password", async () => {
    await expect(claim("testacct", "", GameCode.GS4)).rejects.toThrow("password was missing for testacct")
  })

  test("requires a game code", async () => {
    await expect(claim("testacct", "pw", undefined)).rejects.toThrow("game was missing")
  })
})

describe("claim with bypass_login", () => {
  for (const bypass of [true, "true"] as const) {
    test(`bypass_login=${JSON.stringify(bypass)} claims the account reward only`, async () => {
      const accountClaim = spyOn(Account, "claimAccountRewards").mockResolvedValue(accountOk)
      const list = spyOn(SGE.Secure, "listCharacters").mockResolvedValue([])

      const result = await claim("testacct", "pw", GameCode.GSF, bypass)

      expect(accountClaim).toHaveBeenCalledWith("testacct", "pw", GameCode.GSF)
      expect(list).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: ["testacct | balance claimed 500 simucoins! > 600"], errors: [] })
    })
  }

  test("the string 'false' does not bypass character logins", async () => {
    spyOn(Account, "claimAccountRewards").mockResolvedValue(accountOk)
    const list = spyOn(SGE.Secure, "listCharacters").mockResolvedValue([])

    await claim("testacct", "pw", GameCode.GS4, "false")

    expect(list).toHaveBeenCalledTimes(1)
  })

  test("falls back to BYPASS_LOGIN from the environment", async () => {
    process.env.BYPASS_LOGIN = "true"
    spyOn(Account, "claimAccountRewards").mockResolvedValue(accountOk)
    const list = spyOn(SGE.Secure, "listCharacters").mockResolvedValue([])

    await claim("testacct", "pw", GameCode.GS4)

    expect(list).not.toHaveBeenCalled()
  })
})

describe("claim with character logins", () => {
  test("logs in every character and collects their messages", async () => {
    spyOn(Account, "claimAccountRewards").mockResolvedValue(accountOk)
    spyOn(SGE.Secure, "listCharacters").mockResolvedValue([
      { slot: "W_0", name: "Alpha" },
      { slot: "W_1", name: "Beta" },
    ])
    const getOTP = spyOn(SGE.Secure, "getOTP").mockImplementation(async (_a, _p, _g, name) => otp(name))
    spyOn(Game, "useOTP").mockImplementation(async o => ({ message: `reward for ${o.key}` }))

    const result = await claim("testacct", "pw", GameCode.GS4)

    expect(getOTP.mock.calls.map(c => c[3])).toEqual(["Alpha", "Beta"])
    expect(result.errors).toEqual([])
    expect(result.ok).toEqual([
      "testacct | balance claimed 500 simucoins! > 600",
      "Alpha > reward for key-Alpha",
      "Beta > reward for key-Beta",
    ])
  })

  test("retries a failing character 3 times, records the error, and carries on", async () => {
    spyOn(Account, "claimAccountRewards").mockResolvedValue(accountOk)
    spyOn(SGE.Secure, "listCharacters").mockResolvedValue([
      { slot: "W_0", name: "Alpha" },
      { slot: "W_1", name: "Beta" },
    ])
    const getOTP = spyOn(SGE.Secure, "getOTP").mockImplementation(async (_a, _p, _g, name) => {
      if (name === "Alpha") throw new Error("boom")
      return otp(name)
    })
    spyOn(Game, "useOTP").mockResolvedValue({ message: "already claimed" })

    const result = await claim("testacct", "pw", GameCode.GS4)

    expect(getOTP.mock.calls.filter(c => c[3] === "Alpha")).toHaveLength(3)
    expect(result.errors).toEqual(["Alpha: boom"])
    expect(result.ok).toContain("Beta > already claimed")
  })

  test("an account-reward failure is reported but characters are still processed", async () => {
    spyOn(Account, "claimAccountRewards").mockRejectedValue(new Error("account:testacct | something weird happened"))
    spyOn(SGE.Secure, "listCharacters").mockResolvedValue([{ slot: "W_0", name: "Alpha" }])
    spyOn(SGE.Secure, "getOTP").mockResolvedValue(otp("Alpha"))
    spyOn(Game, "useOTP").mockResolvedValue({ message: "50 silvers" })

    const result = await claim("testacct", "pw", GameCode.GS4)

    expect(result.errors).toEqual(["account:testacct | something weird happened"])
    expect(result.ok).toEqual(["Alpha > 50 silvers"])
  })
})
