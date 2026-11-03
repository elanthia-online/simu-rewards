// Preloaded before every test file (see bunfig.toml).
//
// rewards/account.ts captures `fetch` at import time via makeFetchCookie(fetch),
// so the stub has to be installed before any test imports it. Tests swap the
// handler with setFetchHandler(); with no handler set, any HTTP request fails
// loudly so tests can never reach the real play.net store.

export type FetchHandler = (req: Request) => Response | Promise<Response>

let handler: FetchHandler | null = null

export function setFetchHandler(next: FetchHandler | null) {
  handler = next
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
  if (!handler) {
    throw new Error(`unexpected network request in test: ${req.method} ${req.url}`)
  }
  const res = await handler(req)
  // Real fetch responses carry the request URL; fetch-cookie needs it to store cookies.
  if (!res.url) Object.defineProperty(res, "url", { value: req.url })
  return res
}) as typeof fetch
