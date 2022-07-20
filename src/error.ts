import { SBDSessionResponse } from './types'

export class SBDSessionError extends Error {
    response: SBDSessionResponse
    constructor (message: string, response?: SBDSessionResponse) {
      super(message)
      this.name = this.constructor.name
      this.response = response
      Error.captureStackTrace(this, this.constructor)
    }
}
