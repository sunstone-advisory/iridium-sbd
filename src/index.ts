import { SerialPort, ReadlineParser } from 'serialport'
import { TypedEmitter } from 'tiny-typed-emitter'

import { compress } from './utils'

const OK_REGEXP = /^OK/
const ERROR_REGEXP = /^ERROR/
const SBDRING_REGEXP = /^SBDRING/
const DEFAULT_SIMPLE_TIMEOUT_MS = 2000
const DEFAULT_SESSION_TIMEOUT_MS = 60000
const INDEFINITE_TIMEOUT = -1

export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
    CRITICAL = 'CRITICAL'
}

export type LogEvent = {
    level: LogLevel
    message: string
    datetime: Date
}

export enum SignalQuality {
    ONE = 1,
    TWO = 2,
    THREE = 3,
    FOUR = 4,
    FIVE = 5
}

export type SBDSessionResponse = {
    moStatus: number
    moStatusText: string
    moMessageSequenceNumber: number
    mtStatus: number
    mtStatusText: string
    mtMessageSequenceNumber: number
    mtMessageLength: number
    mtMessagesQueued: number
}

export class SBDSessionError extends Error {
    response: SBDSessionResponse
    constructor (message: string, response?: SBDSessionResponse) {
      super(message)
      this.name = this.constructor.name
      this.response = response
      Error.captureStackTrace(this, this.constructor)
    }
}

export type IridiumCommand = {
    description: string
    timeoutMs: number
    successRegex: RegExp
    bufferRegex?: RegExp
} & ({
    buffer: Buffer
    text?: never
} | {
    text: string
    buffer?: never
})

export interface IridiumControllerInterface {
    'log': (message: LogEvent) => void
    'inbound-message': (message: string) => void
}

export class IridiumController extends TypedEmitter<IridiumControllerInterface> {
    /* The serial port connection to the Iridium modem */
    #serial: SerialPort

    /** Serial port parser to read input based on new line delimeter */
    #readlineParser: ReadlineParser

    /* Indicates a SBDIX session is in progress and should not be interrupted */
    #sessionInProgress: boolean

    /* The current command being executed by the controller */
    command: IridiumCommand

    /* The response string for the command being executed by the controller */
    #response: string = ''

    /* List of commands to be run after the current command has completed */
    #queue: IridiumCommand[] = [] // TODO: messages which are rejected should enter the queue to be processed eventually.

    /* Function to call when the current command has completed successfully */
    resolveFn: Function

    /* Function to call when the current command has not completed successfully */
    rejectFn: Function

    /* Timeout function to call when the current command has not responded in time */
    #timeoutFn: NodeJS.Timeout

    constructor (options?: { serialPath: string; serialBaudRate: number }) {
      super()

      this.#serial = new SerialPort({
        autoOpen: false,
        path: options?.serialPath ?? 'CNCA0', /// dev/ttymxc2',
        baudRate: options?.serialBaudRate ?? 19200
      })

      this.#serial.on('error', error => this.#logger.error(error.message))

      this.#readlineParser = new ReadlineParser({ delimiter: '\r\n' })
      this.#readlineParser.on('data', (data: string) => {
        this.#handleData(data)
      })

      this.#serial.pipe(this.#readlineParser)
    }

    /**
     * Open the connection to the Serial Port and
     * initilise with default commands that are
     * recommended by Iridium/Rock7.
     */
    async init (): Promise<void> {
      return new Promise((resolve, reject) => {
        this.#serial.open((error) => {
          if (error) {
            this.#logger.error(error.message)
            return reject(error)
          }

          this.#logger.info('Connection to serial port has been opened')
          this.disableFlowControl()
            .then(() => this.echoOff())
            .then(() => this.disableSignalMonitoring())
            .then(() => this.clearBuffers())
            .then(() => this.enableAutoRegistration())
            .then(() => this.enableRingAlert())
            .then(() => {
              resolve()
            })
            .catch((error) => reject(error))
        })
      })
    }

    /**
     * Logger object to control output from the Iridium
     * Controller. Log messages are created as {LogEvent}
     * objects and emitted through the 'log' event.
     */
    #logger = {
      lastLogDateTime: new Date(),
      debug: (message: string) => this.#logger.log(LogLevel.DEBUG, message),
      info: (message: string) => this.#logger.log(LogLevel.INFO, message),
      warn: (message: string) => this.#logger.log(LogLevel.WARN, message),
      error: (message: string) => this.#logger.log(LogLevel.ERROR, message),
      critical: (message: string) => this.#logger.log(LogLevel.CRITICAL, message),
      log: (level: LogLevel, message: string) => this.emit('log', { level, datetime: new Date(), message })
    }

    /**
     * Entry point for the data read by the Serial Port
     * parsers. Each response is interpreted in accordance
     * with the current command context. If there is no
     * command context the message is treated as unsolicted.
     */
    #handleData (data: string): void {
      this.#logger.info('<< ' + data)

      // check for unsolicited message types
      if (SBDRING_REGEXP.test(data)) {
        // this.sbdRing()
        return
      }

      if (!this.command) {
        this.#logger.warn('Unexpected message, no active handler')
        return
      }

      // append the response to the buffer
      if (this.command.bufferRegex && this.command.bufferRegex.test(data)) {
        if (this.#response === '') {
          this.#response += data
        } else {
          this.#response += '\n' + data
        }
      }

      // if this is an unexpected error invoke the reject fn
      if (ERROR_REGEXP.test(data)) {
        this.#logger.debug('Received error response, calling reject handler')
        this.rejectFn(this.#response)
        this.#clearContext()
        return
      }

      // if this is the expected end invoke the resolve fn
      if (this.command.successRegex.test(data)) {
        this.#logger.debug('Received expected response, calling resolve handler')
        this.resolveFn(this.#response)
        this.#clearContext()
      }
    }

    /**
     * Clears the current comand context from the controller,
     * allowing for another command to be set and processed.
     * The clearContext() function should be called once the
     * active command has been resolved or rejected.
     */
    #clearContext (): void {
      this.#response = ''
      delete this.resolveFn
      delete this.rejectFn
      delete this.command
      clearTimeout(this.#timeoutFn)
    }

    async echoOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATE0',
        description: 'Turning echo off',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async enableRingAlert ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDMTA=1',
        description: 'Enabling ring alert',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async clearMOBuffers ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD0',
        description: 'Clearing MO buffer',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async clearMTBuffers ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD1',
        description: 'Clearing MT buffer',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async clearBuffers ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD2',
        description: 'Clearing MO/MT buffers',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async disableFlowControl ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT&K0',
        description: 'Disabling flow control',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async enableAutoRegistration ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDAREG=1',
        description: 'Enabling automatic registration',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async disableSignalMonitoring ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+CIER=1,0,0,0',
        description: 'Turning network signal monitoring off',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async waitForNetwork ({ signalQuality = SignalQuality.ONE, timeoutMs = INDEFINITE_TIMEOUT }: { signalQuality?: SignalQuality, timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+CIER=1,1,0,0',
        description: `Turning network signal monitoring on. Waiting for signal quality of ${signalQuality}`,
        timeoutMs,
        successRegex: new RegExp(`^\\+CIEV:0,[${signalQuality}-5]`)
      }).then(() => this.disableSignalMonitoring())
    }

    async writeShortBurstData ({ text, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { text: string, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: 'AT+SBDWT=' + text,
        description: 'Writing short burst data to buffer',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    async writeBinaryShortBurstData ({ buffer, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { buffer: Buffer, timeoutMs?: number }): Promise<void> {
      // copy into a new buffer and calculate/set the checksum.
      // the checksum should be the least significant 2-bytes
      // of the summation of the entire SBD message.
      const output = Buffer.alloc(buffer.length + 2)

      let sum = 0
      for (let i = 0; i < buffer.length; i++) {
        output[i] = buffer[i]
        sum += buffer[i]
      }

      // set the least significant byte of the message summation
      output[output.length - 1] = sum & 0xff

      // drop the least significant byte
      sum >>= 8

      // set the (second) least significant byte of the message summation
      output[output.length - 2] = sum & 0xff

      return new Promise((resolve, reject) => {
        this.#execute({
          text: 'AT+SBDWB=' + buffer.length,
          description: 'Initiating start of binary data write to the buffer',
          timeoutMs,
          successRegex: /^READY/
        })
          .then(() => {
            return this.#execute({
              buffer: output,
              description: 'Writing binary data to the buffer',
              timeoutMs: INDEFINITE_TIMEOUT,
              successRegex: /^[0-3]/,
              bufferRegex: /^[0-3]/
            })
          })
          .then((result) => {
            const code = parseInt(result)
            const description = lookupWriteBinaryResult(code)

            this.#logger.debug(`Response code ${code} - ${description}`)

            if (code > 0) {
              reject(Error(`Error writing binary message to buffer. ${description}`))
            }

            resolve()
          })
          .catch((error) => {
            reject(Error(`Error writing binary message to buffer. ${error}`))
          })
      })
    }

    async initiateSession ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SBDSessionResponse> {
      return this.#execute({
        text: 'AT+SBDIX',
        description: 'Initiating SBD session',
        timeoutMs,
        successRegex: /^OK/,
        bufferRegex: /^\+SBDIX:/
      })
        .then((result) => {
          const data = result.match(/\+SBDIX: (\d+), (\d+), (\d+), (\d+), (\d+), (\d+)/)

          if (data.length > 0) {
            const moStatus = parseInt(data[1])
            const moStatusText = lookupMOStatus(moStatus)
            const moMessageSequenceNumber = parseInt(data[2])
            const mtStatus = parseInt(data[3])
            const mtStatusText = lookupMTStatus(moStatus)
            const mtMessageSequenceNumber = parseInt(data[4])
            const mtMessageLength = parseInt(data[5])
            const mtMessagesQueued = parseInt(data[6])

            this.#logger.debug(`MOSTATUS ${moStatus} - ${moStatusText}`)
            this.#logger.debug(`MOMSN    ${moMessageSequenceNumber}`)
            this.#logger.debug(`MTSTATUS ${mtStatus} - ${mtStatusText}`)
            this.#logger.debug(`MTMSN    ${mtMessageSequenceNumber}`)
            this.#logger.debug(`MTLENGTH ${mtMessageLength}`)
            this.#logger.debug(`MTQUEUED ${mtMessagesQueued}`)

            const response: SBDSessionResponse = {
              moStatus,
              moStatusText,
              moMessageSequenceNumber,
              mtStatus,
              mtStatusText,
              mtMessageLength,
              mtMessageSequenceNumber,
              mtMessagesQueued
            }

            if (moStatus > 4) {
              throw new SBDSessionError(`MO transfer failed with status code '${moStatus}'`, response)
            }

            if (mtStatus === 0) {
              return response
            } else if (mtStatus === 1) {
              this.#logger.info('Attempting to read MT message from the buffer')
              return this.readMessage().then(() => response)
            } else if (mtStatus === 2) {
              // TODO: If failOnMailboxCheckError --> Throw Error?
              return response
            }
          } else {
            throw new SBDSessionError(`Unexpected SBDIX response: ${result}`)
          }
        })
    }

    async readMessage ({ timeoutMs = INDEFINITE_TIMEOUT }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+SBDRT',
        description: 'Reading MT message from the buffer',
        timeoutMs,
        successRegex: /^SBDRT:/,
        bufferRegex: /^SBDRT:/
      })
        .then((response) => {
          const data = response.match(/SBDRT:[^]{2}(.*)/)
          const message = data[1]
          this.#logger.info('Received new message: ' + message)
          this.emit('inbound-message', message)
          return message
        }).finally(() => this.clearMTBuffers())
    }

    async sendMessage (message: string, { signalQuality = SignalQuality.ONE, compressed = false, binary = true, timeoutMs = INDEFINITE_TIMEOUT }:
        { signalQuality?: SignalQuality, compressed?: boolean, binary?: boolean, timeoutMs?: number }): Promise<SBDSessionResponse> {
      let compressedBuffer: Buffer
      if (compressed) {
        compressedBuffer = compress(message)
        const percentage = 100 - Math.round(compressedBuffer.length / message.length * 100)
        this.#logger.info(`Compressed message size ${percentage}% from '${message.length}' to '${compressedBuffer.length}'`)
      }

      return new Promise((resolve, reject) => {
        // TODO: add timeout function. will need to add
        // new class property sessionInProgress to prevent
        // a timeout during session.
        (binary
          ? this.writeBinaryShortBurstData({ buffer: compressedBuffer ?? Buffer.from(message) })
          : this.writeShortBurstData({ text: compressedBuffer ? compressedBuffer.toString('utf-8') : message }))
          .then(() => this.waitForNetwork({ signalQuality }))
          .then(() => this.initiateSession())
          .then((result) => {
            this.clearMOBuffers()
              .then(() => resolve(result))
              .catch((error) => reject(error))
          })
          .catch((error) => reject(error))
      })
    }

    async #execute (command: IridiumCommand): Promise<string> {
      return new Promise((resolve, reject) => {
        if (this.command) {
          this.#logger.warn('Serial connection busy with command, cannot execute another')
          reject(Error('Serial connection busy with command, cannot execute another'))
          // TODO: Add command into queue for processing...
          return
        }

        if (!this.#serial.isOpen) {
          reject(Error('Serial connection is not open. Call the init() function to open the connection'))
          return
        }

        // set up the reject and resolver functions,
        // which will be called from the data handler.
        this.command = command
        this.rejectFn = reject
        this.resolveFn = resolve

        // set up the timeout function for the command.
        if (command.timeoutMs > 0) {
          this.#timeoutFn = setTimeout(() => {
            this.#logger.warn(`Function timeout. Response not received within ${command.timeoutMs}ms`)
            this.#clearContext()
            reject(Error('Timeout'))
          }, command.timeoutMs)
        }

        // write the command to the serial connection
        if (command.buffer) {
          this.#logger.info(command.description ?? 'Writing binary to buffer')
          this.#logger.info('>> [STRING] ' + command.buffer)
          this.#logger.info('>> [BINARY] ' + command.buffer.toString('hex'))
          this.#serial.write(command.buffer)
        } else {
          this.#logger.info(command.description ?? `Executing ${command.text}`)
          this.#logger.info('>> ' + command.text)
          this.#serial.write(command.text + '\r\n')
        }
      })
    }
}

// TODO: Replace with generic reference data lookup function
function lookupWriteBinaryResult (code: number) {
  switch (code) {
    case 0:
      return 'SBD message successfully written to the device'
    case 1:
      return 'SBD message write timeout. An insufficient number of bytes were transferred to the device during the transfer period of 60 seconds'
    case 2:
      return 'SBD message checksum sent from DTE does not match the checksum calculated by the device'
    case 3:
      return 'SBD message size is not correct. The maximum mobile originated SBD message length is 340 bytes. The minimum mobile originated SBD message length is 1 byte'
    default:
      return 'Unknown response code received from the device'
  }
}

// TODO: Replace with generic reference data lookup function
function lookupMTStatus (mtStatus: number) {
  switch (mtStatus) {
    case 0:
      return 'No MT messages are pending'
    case 1:
      return 'MT message was received during the MO transfer'
    default:
      return 'Error occured while checking the MT mailbox or receiving a message on the GSS'
  }
}

// TODO: Replace with generic reference data lookup function
function lookupMOStatus (moStatus: number) {
  switch (moStatus) {
    case 0:
      return 'MO transfer was successful'
    case 1:
      return 'MO transfer was successful, but the MT message in the queue was to big to be transferred'
    case 2:
      return 'MO transfer was successful, but the requested location update was no accepted'
    case 3:
    case 4:
      return 'MO transfer was successful'
    case 10:
      return 'MO transfer failed. GSS reported that the call did not complete in the allowed time'
    case 11:
      return 'MO transfer failed. MO message queue at the GSS is full'
    case 12:
      return 'MO transfer failed. MO message has too many segments'
    case 13:
      return 'MO transfer failed. GSS reported that the session did not complete'
    case 14:
      return 'MO transfer failed. Invalid segment size'
    case 15:
      return 'MO transfer failed. Access is denied'
    case 16:
      return 'MO transfer failed. ISU has been locked and may not make SBD calls (see +CULK command)'
    case 17:
      return 'MO transfer failed. Gateway not responding (local session timeout)'
    case 18:
      return 'MO transfer failed. Connection lost (RF drop)'
    case 19:
      return 'MO transfer failed. Link failure (A protocol error caused termination of the call)'
    case 32:
      return 'MO transfer failed. No network service, unable to initiate call'
    case 33:
      return 'MO transfer failed. Antenna fault, unable to initiate call'
    case 34:
      return 'MO transfer failed. Radio is disabled, unable to initiate call (see *Rn command)'
    case 35:
      return 'MO transfer failed. ISU is busy, unable to initiate call'
    case 36:
      return 'MO transfer failed. Try later, must wait 3 minutes since last registration'
    case 37:
      return 'MO transfer failed. SBD service is temporarily disabled'
    case 38:
      return 'MO transfer failed. Try later, traffic management period (see +SBDLOE command)'
    case 64:
      return 'MO transfer failed. Band violation (attempt to transmit outside permitted frequency band'
    case 65:
      return 'MO transfer failed. PLL lock failure; hardware error during attempted transmit'
    default:
      return 'MO transfer failed. Response code not specified in specification'
  }
}
