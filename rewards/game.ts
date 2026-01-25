import * as net from "net"
import type { OTP } from "./eaccess/secure";

interface UseOTPOptions {
  maxAttempts?: number
  timeoutMs?: number
  delayMs?: number
  connectTimeoutMs?: number
}

async function attemptOTP(otp: OTP, connectTimeoutMs: number): Promise<{message: string}> {
  return new Promise((ok, err)=> {
    const game = new net.Socket()
    game.setDefaultEncoding("ascii")
    
    let connectionTimeout: NodeJS.Timeout | null = null
    let connected = false

    // Set a timeout for the connection attempt
    connectionTimeout = setTimeout(() => {
      if (!connected) {
        game.destroy()
        err(new Error(`Connection timeout after ${connectTimeoutMs}ms`))
      }
    }, connectTimeoutMs)

    game.connect({host: otp.host, port: otp.port}, ()=> {  
      connected = true
      if (connectionTimeout) clearTimeout(connectionTimeout)
      //console.log("connected to %s:%s", otp.host, otp.port)
      game.write(otp.key + "\n")
      game.write("/FE:STORMFRONT /VERSION:1.0.1.22 /XML\n")
    })

    game.on("data", (data : Buffer) => {
      const incoming = data.toString()
      //console.log(incoming)
      if (incoming.startsWith("<settingsInfo ")) {
        game.write("<c>\r\n")
        game.write("<c>\r\n")
      }

      if (incoming.includes("You have earned the following reward:")) {
        const m = incoming.match(/You have earned the following reward: (.*)!/)
        const message = m ? m[1] : "claimed login reward"
        if (connectionTimeout) clearTimeout(connectionTimeout)
        game.destroy()
        ok({message: message})
      }

      if (incoming.includes("consecutive days, you have earned")) {
        const m = incoming.match(/consecutive days, you have earned (.*)(?:!|\.)/)
        const message = m ? m[1] : "claimed login reward"
        if (connectionTimeout) clearTimeout(connectionTimeout)
        game.destroy()
        ok({message: message})
      }

      if (incoming.includes(`<prompt time=`)) {
        if (connectionTimeout) clearTimeout(connectionTimeout)
        game.destroy()
        ok({message: "already claimed"})
      }
    })

    game.on("error", (error) => {
      if (connectionTimeout) clearTimeout(connectionTimeout)
      err(error)
    })
  })
}

export async function useOTP (otp : OTP, options: UseOTPOptions = {}) : Promise<{message: string}> {
  const { 
    maxAttempts = 3, 
    timeoutMs = 60_000, 
    delayMs = 5000,
    connectTimeoutMs = 10_000 
  } = options
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await Promise.race([
        attemptOTP(otp, connectTimeoutMs),
        new Promise<{message: string}>((_, reject) => 
          setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      ])
      
      return outcome
      
    } catch (err: any) {
      const isLastAttempt = attempt === maxAttempts
      
      if (isLastAttempt) {
        throw err
      } else {
        console.warn(`Attempt ${attempt}/${maxAttempts} failed: ${err.message} - retrying in ${delayMs}ms...`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  
  throw new Error(`Failed after ${maxAttempts} attempts`)
}
