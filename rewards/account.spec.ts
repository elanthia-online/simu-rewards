import { afterEach, describe, expect, test } from "bun:test"
import { setFetchHandler } from "../test/setup"
import { claimAccountRewards, getToken } from "./account"
import { GameCode } from "./eaccess/secure"

// Minimal versions of the store.play.net pages that account.ts scrapes.
const signInPage = (token: string) => `
  <form action="/Account/SignIn" method="post">
    <input name="__RequestVerificationToken" type="hidden" value="${token}" />
    <input name="UserName" /><input name="Password" type="password" />
  </form>`

const storePage = ({ login, reward, balance }: { login: string; reward: string; balance: string }) => `
  <div id="login">${login}</div>
  <div class="balance">Balance: <span>${balance}</span></div>
  <div class="RewardMessage">${reward}</div>
  <form action="/Store/ClaimReward" method="post"><input type="submit" value="Claim" /></form>`

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } })

interface Seen { method: string; url: string; cookie: string | null; form?: Record<string, string> }

// Routes the three store requests, recording what each one carried.
function store(routes: {
  signInGet?: () => Response
  signInPost: () => Response
  claim?: () => Response
}) {
  const seen: Seen[] = []
  setFetchHandler(async req => {
    const entry: Seen = { method: req.method, url: req.url, cookie: req.headers.get("cookie") }
    if (req.method === "POST") entry.form = Object.fromEntries((await req.formData()) as any)
    seen.push(entry)

    const url = new URL(req.url)
    if (url.pathname === "/Account/SignIn" && req.method === "GET") {
      return routes.signInGet?.() ?? html(signInPage("csrf-token-1"), { "set-cookie": "session=abc123; Path=/; Secure; HttpOnly" })
    }
    if (url.pathname === "/Account/SignIn" && req.method === "POST") return routes.signInPost()
    if (url.pathname === "/Store/ClaimReward" && routes.claim) return routes.claim()
    throw new Error(`unexpected request ${req.method} ${req.url}`)
  })
  return seen
}

afterEach(() => setFetchHandler(null))

describe("getToken", () => {
  test("extracts the CSRF token from the sign-in page", async () => {
    store({ signInPost: () => html("") })
    await expect(getToken(GameCode.GS4)).resolves.toBe("csrf-token-1")
  })

  test("throws when the sign-in page has no token", async () => {
    store({ signInGet: () => html("<html>maintenance</html>"), signInPost: () => html("") })
    await expect(getToken(GameCode.GS4)).rejects.toThrow("could not parse csrf token")
  })
})

describe("claimAccountRewards", () => {
  test("GS: signs in, claims the reward, and keeps the session cookie between requests", async () => {
    const seen = store({
      signInPost: () => html(storePage({ login: "Welcome, TestAcct", reward: "Your reward is ready", balance: "100" })),
      claim: () => html(storePage({ login: "Welcome, TestAcct", reward: "Claimed 500 SimuCoins!", balance: "600" })),
    })

    await expect(claimAccountRewards("testacct", "hunter2", GameCode.GS4)).resolves.toEqual({
      account: "testacct",
      message: "claimed 500 simucoins!",
      balance: "600",
    })

    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual([
      "GET https://store.play.net/Account/SignIn?returnURL=%2Fstore%2Fpurchase%2Fgs",
      "POST https://store.play.net/Account/SignIn?returnURL=%2Fstore%2Fpurchase%2Fgs",
      "POST https://store.play.net/Store/ClaimReward",
    ])
    expect(seen[1].form).toEqual({ UserName: "testacct", Password: "hunter2", __RequestVerificationToken: "csrf-token-1" })
    expect(seen[2].form).toEqual({ game: "GS" })
    // fetch-cookie must replay the Set-Cookie from the first response
    expect(seen[1].cookie).toContain("session=abc123")
    expect(seen[2].cookie).toContain("session=abc123")
  })

  test("DR: uses the DR store URL and claims for game=DR", async () => {
    const seen = store({
      signInPost: () => html(storePage({ login: "Welcome, TestAcct", reward: "Your reward is ready", balance: "5" })),
      claim: () => html(storePage({ login: "Welcome, TestAcct", reward: "Claimed 500 SimuCoins!", balance: "505" })),
    })

    await claimAccountRewards("testacct", "hunter2", GameCode.DRF)

    expect(seen[0].url).toBe("https://store.play.net/Account/SignIn?returnURL=%2Fstore%2Fpurchase%2Fdr")
    expect(seen[2].form).toEqual({ game: "DR" })
  })

  test("returns without claiming when the reward was already collected", async () => {
    const seen = store({
      signInPost: () => html(storePage({ login: "Welcome, TestAcct", reward: "Next Subscription Bonus in 12 days", balance: "600" })),
    })

    await expect(claimAccountRewards("testacct", "hunter2", GameCode.GS4)).resolves.toEqual({
      account: "testacct",
      message: "Next Subscription Bonus in 12 days",
      balance: "600",
    })
    expect(seen.some(s => s.url.includes("ClaimReward"))).toBe(false)
  })

  test("reports a probable wrong password when the store still shows Sign In", async () => {
    store({ signInPost: () => html(storePage({ login: " Sign In ", reward: "", balance: "" })) })

    await expect(claimAccountRewards("testacct", "wrong", GameCode.GS4)).rejects.toThrow(
      "account:testacct | password is probably wrong",
    )
  })

  test("reports a generic login failure for any other page", async () => {
    store({ signInPost: () => html(storePage({ login: "Welcome, SomeoneElse", reward: "", balance: "" })) })

    await expect(claimAccountRewards("testacct", "hunter2", GameCode.GS4)).rejects.toThrow(
      "account:testacct | something went wrong attempting to log in",
    )
  })

  test("throws when the claim response is not a success", async () => {
    store({
      signInPost: () => html(storePage({ login: "Welcome, TestAcct", reward: "Your reward is ready", balance: "100" })),
      claim: () => html(storePage({ login: "Welcome, TestAcct", reward: "An error occurred", balance: "100" })),
    })

    await expect(claimAccountRewards("testacct", "hunter2", GameCode.GS4)).rejects.toThrow(
      "account:testacct | something weird happened",
    )
  })
})
