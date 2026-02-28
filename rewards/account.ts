import makeFetchCookie from 'fetch-cookie'
import * as cheerio from "cheerio"
import type { GameCode } from "./eaccess/secure"

const claimReward = "https://store.play.net/Store/ClaimReward"

const fetchWithCookies = makeFetchCookie(fetch)

function signinUrl (gameCode : GameCode) {
  if (gameCode.startsWith("GS")) {
    return "https://store.play.net/Account/SignIn?returnURL=%2Fstore%2Fpurchase%2Fgs"
  } else {
    return "https://store.play.net/Account/SignIn?returnURL=%2Fstore%2Fpurchase%2Fdr"
  }
}

export async function getToken (gameCode : GameCode) {
  const storeUrl = signinUrl(gameCode)
  
  const response = await fetchWithCookies(storeUrl)
  const html = await response.text()
  const $ = cheerio.load(html)
  
  const token = $("[name='__RequestVerificationToken']").val() as string

  if (!token) {
    throw new Error("could not parse csrf token")
  }

  return token
}

export async function login (account: string, password : string, gameCode : GameCode) {
  const token = await getToken(gameCode)
  const storeUrl = signinUrl(gameCode)
  const auth = new FormData()
  auth.set("UserName", account)
  auth.set("Password", password)
  auth.set("__RequestVerificationToken", token)

  const login = await fetchWithCookies(storeUrl, {
    method: "POST",
    body: auth,
  })

  const state = {
    authenticated_account: "",
    balance: "",
    next: "",
    cheerio: cheerio.load(await login.text()),
  }

  const authenticated_account = state.cheerio("#login").text()

  if (authenticated_account.toLowerCase().includes(account.toLowerCase())) {
    state.authenticated_account = account
  }

  if (!state.authenticated_account) {
    if (authenticated_account.toLowerCase().trim().includes("sign in")) {
      throw new Error(`account:${account} | password is probably wrong`)  
    }
    throw new Error(`account:${account} | something went wrong attempting to log in`)
  }

  state.next = state.cheerio(".RewardMessage").text()
  state.balance = state.cheerio(".balance > span").text()
  return state
}


export async function claimAccountRewards (account : string, password: string, gameCode : GameCode) {
  const state = await login(account, password, gameCode)

  if (state.next.toLowerCase().startsWith("next subscription bonus")) {
    return {account, message: state.next, balance: state.balance}
  }
  
  const data = [...state.cheerio(`form[action='/Store/ClaimReward'] input`)]
  const form = new FormData()
  if (gameCode.startsWith("GS")) {
    form.set("game", "GS")
  } else {
    form.set("game", "DR")
  }
  const claim = await fetchWithCookies(claimReward, {
    method: "POST",
    body: form,
  })

  const $ = cheerio.load(await claim.text())
  const message = $(".RewardMessage").text().toLowerCase()
  if (message.startsWith("claimed")) {
    return {account, message, balance: $(".balance > span").text()}
  }

  throw new Error(`account:${account} | something weird happened`)
}
