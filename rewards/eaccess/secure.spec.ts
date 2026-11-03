import { afterEach, describe, expect, mock, test } from "bun:test"
import { GameCode, getOTP, listCharacters, parseGameList, sendAccountDetails, tsv, tsvToRecord } from "./secure"
import { installFakeSGE, MASK } from "../../test/fake-sge"
import { trackTimers } from "../../test/setup"

afterEach(() => mock.restore())

const characters = [
  { slot: "W_TESTACCT_000", name: "Alpha" },
  { slot: "W_TESTACCT_001", name: "Beta" },
]

describe("tsv helpers", () => {
  test("tsv trims and splits on tabs", () => {
    expect(tsv("C\t1\t2\n")).toEqual(["C", "1", "2"])
  })

  test("tsvToRecord pairs alternating keys and values", () => {
    expect(tsvToRecord(["a", "1", "b", "2"])).toEqual({ a: "1", b: "2" })
  })

  test("parseGameList drops the leading command letter", () => {
    expect(parseGameList("M\tGS3\tGemStone IV\tDR\tDragonRealms\n")).toEqual({
      GS3: "GemStone IV",
      DR: "DragonRealms",
    })
  })
})

describe("sendAccountDetails", () => {
  test("writes the account name followed by the masked password", () => {
    const writes: Buffer[] = []
    const sock = { write: (b: Buffer) => writes.push(b) } as any
    sendAccountDetails(sock, "acct", "pw", MASK)

    expect(writes).toHaveLength(1)
    const expected = Buffer.from([
      ...Buffer.from("A\tacct\t"),
      ((MASK.charCodeAt(0) ^ ("p".charCodeAt(0) - 32)) + 32),
      ((MASK.charCodeAt(1) ^ ("w".charCodeAt(0) - 32)) + 32),
    ])
    expect(writes[0]).toEqual(expected)
  })
})

describe("listCharacters", () => {
  test("authenticates and returns every character slot", async () => {
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "GS3", characters })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).resolves.toEqual(characters)

    expect(sge.connectOptions[0]).toMatchObject({ host: "eaccess.play.net", port: 7910 })
    expect(sge.received).toEqual(expect.arrayContaining(["K", "M", "N\tGS3\n", "G\tGS3\n", "C\n"]))
    expect(sge.destroyed()).toBe(true)
  })

  test("requests the configured game code", async () => {
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "DRF", characters })

    await sge.run(listCharacters("testacct", "hunter2", GameCode.DRF))

    expect(sge.received).toContain("N\tDRF\n")
    expect(sge.received).toContain("G\tDRF\n")
  })

  test("rejects on a wrong password", async () => {
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "GS3", characters })

    await expect(sge.run(listCharacters("testacct", "wrong", GameCode.GS4))).rejects.toThrow(
      "account:testacct | invalid password",
    )
  })

  test("rejects on a PROBLEM response", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      overrides: { A: "A\tTESTACCT\tPROBLEM\n" },
    })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).rejects.toThrow("PROBLEM")
  })
})

describe("getOTP", () => {
  test("logs in the requested character (case-insensitive) and returns the game key", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      gameHost: "storm.gs4.game.play.net", gamePort: 10024, gameKey: "abc123",
    })

    await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "beta"))).resolves.toEqual({
      key: "abc123",
      host: "storm.gs4.game.play.net",
      port: 10024,
    })
    expect(sge.received).toContain("L\tW_TESTACCT_001\tSTORM\n")
    expect(sge.destroyed()).toBe(true)
  })

  test("rejects when the account has no such character", async () => {
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "GS3", characters })

    await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Gamma"))).rejects.toThrow(
      "account testacct does not have requested character Gamma",
    )
  })

  test("rejects on unexpected server text after character selection", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      overrides: { L: "X\tSOMETHING ELSE\n" },
    })

    await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Alpha"))).rejects.toThrow("unknown text received")
  })
})

describe("eAccess reply framing", () => {
  test("replies split across several packets are reassembled", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      gameHost: "storm.gs4.game.play.net", gamePort: 10024, gameKey: "abc123",
      chunkSize: 7,
    })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).resolves.toEqual(characters)
  })

  test("a split launch reply still yields the full key, host and port", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      gameHost: "storm.gs4.game.play.net", gamePort: 10024, gameKey: "abc123",
      chunkSize: 5,
    })

    await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Alpha"))).resolves.toEqual({
      key: "abc123", host: "storm.gs4.game.play.net", port: 10024,
    })
  })

  test("a reply without a trailing newline is still handled", async () => {
    const sge = installFakeSGE({
      account: "testacct", password: "hunter2", gameCode: "GS3", characters,
      overrides: { C: "C\t1\t1\t0\t0\tW_TESTACCT_000\tAlpha" },
    })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4, { partialReplyMs: 50 }))).resolves.toEqual([characters[0]])
  })
})

describe("eAccess failures reject instead of throwing or hanging", () => {
  const base = { account: "testacct", password: "hunter2", gameCode: "GS3", characters }

  test("any non-KEY login reply (e.g. NORECORD) rejects", async () => {
    const sge = installFakeSGE({ ...base, overrides: { A: "A\t\tNORECORD\n" } })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).rejects.toThrow(
      "account:testacct | login rejected: A\t\tNORECORD",
    )
    expect(sge.destroyed()).toBe(true)
  })

  test("a hash key shorter than the password rejects", async () => {
    const sge = installFakeSGE({ ...base, overrides: { K: "abc" } })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).rejects.toThrow(
      "malformed hash key from eAccess (3 bytes for a 7 character password)",
    )
    expect(sge.destroyed()).toBe(true)
  })

  test("L\\tPROBLEM rejects with the server's reply", async () => {
    const sge = installFakeSGE({ ...base, overrides: { L: "L\tPROBLEM\t1\n" } })

    await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Alpha"))).rejects.toThrow(
      "account:testacct | Alpha could not be launched: L\tPROBLEM\t1",
    )
  })

  for (const field of ["KEY", "GAMEHOST", "GAMEPORT"]) {
    test(`a launch reply missing ${field} rejects`, async () => {
      const fields = { GAMEHOST: "storm.example.test", GAMEPORT: "10024", KEY: "abc123" } as Record<string, string>
      delete fields[field]
      const launch = "L\tOK\t" + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\t") + "\n"
      const sge = installFakeSGE({ ...base, overrides: { L: launch } })

      await expect(sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Alpha"))).rejects.toThrow(
        `eAccess launch reply is missing ${field}`,
      )
      expect(sge.listenerErrors).toEqual([])
      expect(sge.destroyed()).toBe(true)
    })
  }

  test("a socket error rejects", async () => {
    const sge = installFakeSGE({ ...base, onConnect: s => s.emit("error", new Error("ECONNRESET")) })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).rejects.toThrow("ECONNRESET")
    expect(sge.destroyed()).toBe(true)
  })

  test("the server closing the connection mid-login rejects", async () => {
    const sge = installFakeSGE({ ...base, overrides: { M: null }, onConnect: s => setTimeout(() => s.emit("close"), 20) })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4))).rejects.toThrow(
      "account:testacct | eAccess closed the connection before login completed",
    )
  })

  test("a server that stops replying times out", async () => {
    const sge = installFakeSGE({ ...base, overrides: { C: null } })

    await expect(sge.run(listCharacters("testacct", "hunter2", GameCode.GS4, { timeoutMs: 50 }))).rejects.toThrow(
      "account:testacct | eAccess timed out after 50ms",
    )
    expect(sge.destroyed()).toBe(true)
  })
})

describe("eAccess session cleanup", () => {
  test("the overall timeout is cleared once the exchange succeeds", async () => {
    const timers = await trackTimers(4321)
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "GS3", characters })

    await sge.run(getOTP("testacct", "hunter2", GameCode.GS4, "Alpha", { timeoutMs: 4321 }))

    expect(timers.created()).toBe(1)
    expect(timers.allCleared()).toBe(true)
  })

  test("the overall timeout is cleared when the exchange fails", async () => {
    const timers = await trackTimers(4321)
    const sge = installFakeSGE({ account: "testacct", password: "hunter2", gameCode: "GS3", characters })

    await expect(sge.run(listCharacters("testacct", "wrong", GameCode.GS4, { timeoutMs: 4321 }))).rejects.toThrow()

    expect(timers.allCleared()).toBe(true)
  })
})
