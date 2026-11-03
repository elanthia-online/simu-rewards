import { afterEach, describe, expect, mock, test } from "bun:test"
import { GameCode, getOTP, listCharacters, parseGameList, sendAccountDetails, tsv, tsvToRecord } from "./secure"
import { installFakeSGE, MASK } from "../../test/fake-sge"

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
      overrides: { A: "A\tTESTACCT\tPROBLEM" },
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
