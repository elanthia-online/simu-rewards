import * as Account from "./account"
import * as SGE from "./sge"
import * as Game from "./game"
import type { GameCode } from "./eaccess/secure"

export {Account, SGE, Game}

interface RetryOptions {
  maxAttempts?: number
  timeoutMs?: number
  delayMs?: number
}

async function retryCharacterLogin(
  character: { name: string },
  account: string,
  password: string,
  gameCode: GameCode,
  options: RetryOptions = {}
): Promise<string> {
  const { maxAttempts = 3, timeoutMs = 60_000, delayMs = 1000 } = options
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const otp = await SGE.Secure.getOTP(account, password, gameCode, character.name)
      
      const outcome = await Promise.race([
        Game.useOTP(otp),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      ]) as Awaited<ReturnType<typeof Game.useOTP>>
      
      const msg = `${character.name} > ${outcome.message}`
      console.log(msg)
      return msg
      
    } catch (err: any) {
      const isLastAttempt = attempt === maxAttempts
      const errMsg = `${character.name} attempt ${attempt}/${maxAttempts} failed: ${err.message}`
      
      if (isLastAttempt) {
        console.error(errMsg)
        throw err
      } else {
        console.warn(`${errMsg} - retrying in ${delayMs}ms...`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  
  throw new Error(`${character.name} failed after ${maxAttempts} attempts`)
}

export async function claim (account?: string, password?: string, gameCode?: GameCode) {
  if (!account) {
    throw new Error("account was missing")
  }

  if (!password) {
    throw new Error(`password was missing for ${account}`)
  }

  if (!gameCode) {
    throw new Error("game was missing")
  }

  const errors: string[] = []
  const ok: string[] = []

  // Claim account rewards
  try {
    const res = await Account.claimAccountRewards(account, password, gameCode)
    const msg = `${res.account} | balance ${res.message} > ${res.balance}`
    ok.push(msg)
    console.log(msg)
  } catch (err: any) {
    console.error(err)
    errors.push(err.message)
  }

  // Get all characters
  const characters = await SGE.Secure.listCharacters(account, password, gameCode)
  console.log(`Processing ${characters.length} characters...`)

  // Process each character with retry logic
  for (const character of characters) {
    try {
      const msg = await retryCharacterLogin(character, account, password, gameCode, {
        maxAttempts: 3,
        timeoutMs: 60_000,
        delayMs: 2000  // 2 second delay between retries
      })
      ok.push(msg)
      
      // Small delay between characters to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 500))
      
    } catch (err: any) {
      console.error(`Failed to process ${character.name}:`, err)
      errors.push(`${character.name}: ${err.message}`)
      // Continue processing remaining characters even if one fails
    }
  }

  console.log(`\nSummary: ${ok.length} succeeded, ${errors.length} failed`)
  
  return {ok, errors}
}
