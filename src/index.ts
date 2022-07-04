import { SerialPort, ReadlineParser } from 'serialport'
import { TypedEmitter } from 'tiny-typed-emitter'

import { compress } from './utils'

const OK_REGEXP = /^OK$/
const ANY_REGEXP = /^.+/
const ERROR_REGEXP = /^ERROR/
const SBDRING_REGEXP = /^SBDRING/
const DEFAULT_SIMPLE_TIMEOUT_MS = 2000
const DEFAULT_LONG_TIMEOUT_MS = 30000
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

export enum ConfigProfile {
  PROFILE_0 = 0,
  PROFILE_1 = 1
}

export enum RingIndicationStatus {
  NO_RING_ALERT_RECEIVED = 0,
  RING_ALERT_RECEIVED = 1
}

export enum LockStatus {
  UNLOCKED = 0,
  LOCKED = 1,
  PERMANENTLY_LOCKED = 2
}

export enum BaudRate {
  RATE_600_BPS = 1,
  RATE_1200_BPS = 2,
  RATE_2400_BPS = 3,
  RATE_4800_BPS = 4,
  RATE_9600_BPS = 5,
  RATE_19200_BPS = 6,
  RATE_38400_BPS = 7,
  RATE_57600_BPS = 8,
  RATE_115200_BPS = 9
}

export enum NetworkRegistrationStatus {
  DETACHED = 0,
  NOT_REGISTERED = 1,
  REGISTERED = 2,
  REGISTRATION_DENIED = 3,
  UNKNOWN = 4
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

export type SBDStatusResponse = {
  moMessageInBuffer: boolean
  mtMessageInBuffer: boolean
  moMessageSequenceNumber: number
  mtMessageSequenceNumber: number
}

export type SBDStatusExtendedResponse = SBDStatusResponse & {
  unansweredRingAlert: boolean
  messagesWaitingCount: number
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
    errorRegex?: RegExp
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
    'ring-alert': () => void
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

          this.#logger.info(`Connection to serial port '${this.#serial.port.openOptions.path}' has been opened`)
          this.flowControlDisable()
            .then(() => this.echoOff())
            .then(() => this.indicatorEventReportingDisable())
            .then(() => this.clearBuffers())
            .then(() => this.autoRegistrationEnable())
            .then(() => this.ringAlertEnable())
            .then(() => {
              resolve()
            })
            .catch((error) => reject(error))
        })
      })
    }

    /**
     * Closes the connection the the Serial Port.
     */
    async close (): Promise<void> {
      return new Promise((resolve, reject) => {
        if (this.#serial.isOpen) {
          this.#serial.close((error) => {
            if (error) return reject(error)
            resolve()
          })
        } else {
          resolve()
        }
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
        this.#logger.debug('Received SBD ring alert, emitting ring-alert event')
        this.emit('ring-alert')
        return
      }

      if (!this.command) {
        this.#logger.warn('Unexpected message, no active handler')
        return
      }

      // if this is an unexpected error invoke the reject fn
      if ((this.command.errorRegex ?? ERROR_REGEXP).test(data)) {
        this.#logger.debug('Received error response, calling reject handler')
        this.rejectFn(this.#response)
        this.#clearContext()
        return
      }

      // append the response to the buffer
      if (this.command.bufferRegex && // do we need to buffer the response
            this.command.bufferRegex.test(data) && // does this match the buffer criteria
            this.command.text !== data) { // ignore echo of commands back to port
        // if (!(
        //  this.command.bufferRegex === this.command.successRegex &&
        //  this.command.successRegex === OK_REGEXP)) {
        if (this.#response === '') {
          this.#response += data
        } else {
          this.#response += '\n' + data
        }
        // }
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

    'ATE0' = this.echoOff
    async echoOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATE0',
        description: 'Turning echo off',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'ATE1' = this.echoOn
    async echoOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATE1',
        description: 'Turning echo on',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'ATI3' = this.getSoftwareRevisionLevel
    async getSoftwareRevisionLevel ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'ATI3',
        description: 'Querying the software revision level',
        timeoutMs,
        bufferRegex: ANY_REGEXP,
        successRegex: OK_REGEXP
      })
    }

    'ATI4' = this.getProductDescription
    async getProductDescription ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'ATI4',
        description: 'Querying the product description',
        timeoutMs,
        bufferRegex: ANY_REGEXP,
        successRegex: OK_REGEXP
      })
    }

    'ATI7' = this.getHardwareSpecification
    async getHardwareSpecification ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'ATI7',
        description: 'Querying the hardware specification',
        timeoutMs,
        bufferRegex: ANY_REGEXP,
        successRegex: OK_REGEXP
      })
    }

    'ATQ0' = this.quietModeOff
    async quietModeOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATQ0',
        description: 'Turning quiet mode off. 9602 responses will be sent to the DTE',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    // Removed as quiet mode needs to be disabled for the library to work
    /*
    'ATQ1' = this.quietModeOn
    async quietModeOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATQ1',
        description: 'Turning quiet mode on. 9602 responses will not be sent to the DTE',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }
    */

    // Removed as verbose mode needs to be enabled for the library to work
    /*
    'ATV0' = this.verboseModeOff
    async verboseModeOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATV0',
        description: 'Turning verbose mode off (textual responses disabled)',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }
    */

    'ATV1' = this.verboseModeOn
    async verboseModeOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'ATV1',
        description: 'Turning verbose mode on (textual responses enabled)',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'ATZn' = this.restoreUserConfig
    async restoreUserConfig ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: `ATZ${profile}`,
        description: `Soft reset. Restoring user configuration ${profile}`,
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT&F0' = this.restoreFactorySettings
    async restoreFactorySettings ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT&F0',
        description: 'Restoring factory settings',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT&K0' = this.flowControlDisable
    async flowControlDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT&K0',
        description: 'Disabling RTS/CTS flow control',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT&K3' = this.flowControlEnable
    async flowControlEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT&K3',
        description: 'Enabling RTS/CTS flow control',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT&V' = this.getActiveStoredConfig
    async getActiveStoredConfig ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT&V',
        description: 'Retrieving active and stored configuration profiles',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
      // TODO: Parse this into an object
    }

    'AT&Wn' = this.saveActiveConfig
    async saveActiveConfig ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: `AT&W${profile}`,
        description: `Storing current (active) configuration as profile ${profile}`,
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT&Yn' = this.designateDefaultResetProfile
    async designateDefaultResetProfile ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: `AT&Y${profile}`,
        description: `Setting profile ${profile} as default power up configuration`,
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT%R' = this.getSRegisters
    async getSRegisters ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT%R',
        description: 'Retrieving the system S-Registers',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
      // TODO: Parse these into an array of objects.
    }

    'AT*F' = this.prepareForShutdown
    async prepareForShutdown ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT*F',
        description: 'Preparing for power down. Radio will be disabled and all pending writes flushed to the EEPROM',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT*R0' = this.radioActivityDisable
    async radioActivityDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT*R0',
        description: 'Disabling radio activity',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT*R1' = this.radioActivityEnable
    async radioActivityEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT*R1',
        description: 'Enabling radio activity',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+CCLK' = this.getIridiumSystemTime
    async getIridiumSystemTime ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+CCLK',
        description: 'Querying the Iridium system time if available',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
    }

    'AT+CGMI' = this.getDeviceManufacturer
    async getDeviceManufacturer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+CGMI',
        description: 'Querying the device manufacturer',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
    }

    'AT+CGMM' = this.getDeviceModel
    async getDeviceModel ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+CGMM',
        description: 'Querying the device model',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
    }

    'AT+CGMR' = this.getDeviceModelRevision
    async getDeviceModelRevision ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+CGMR',
        description: 'Querying the device model revision',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
      // TODO: Parse response into object.
    }

    'AT+CGSN' = this.getDeviceSerialNumber
    async getDeviceSerialNumber ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+CGSN',
        description: 'Querying the device serial number',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
      })
    }

    async waitForNetwork ({ signalQuality = SignalQuality.ONE, timeoutMs = INDEFINITE_TIMEOUT }: { signalQuality?: SignalQuality, timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+CIER=1,1,0,0',
        description: `Turning network signal monitoring on. Waiting for signal quality of ${signalQuality}`,
        timeoutMs,
        successRegex: new RegExp(`^\\+CIEV:0,[${signalQuality}-5]`)
      }).then(() => this.indicatorEventReportingDisable())
    }

    'AT+CIER=1,1,0,0' = this.signalMonitoringEnable
    async signalMonitoringEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      // TODO: This may conflict with serviceAvailabilityMonitoringEnable
      return this.#execute({
        text: 'AT+CIER=1,1,0,0',
        description: 'Turning network signal monitoring on',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+CIER=1,0,1,0' = this.serviceAvailabilityMonitoringEnable
    async serviceAvailabilityMonitoringEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      // TODO: This may conflict with signalMonitoringEnable
      return this.#execute({
        text: 'AT+CIER=1,0,1,0',
        description: 'Turning service availability monitoring on',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+CIER=1,0,0,0' = this.indicatorEventReportingDisable
    async indicatorEventReportingDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      // TODO: This may conflict with signalMonitoringEnable
      return this.#execute({
        text: 'AT+CIER=1,0,0,0',
        description: 'Turning indicator event monitoring off',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+CRIS' = this.getRingIndicationStatus
    async getRingIndicationStatus ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<RingIndicationStatus> {
      return this.#execute({
        text: 'AT+CRIS',
        description: 'Querying the ring indication status',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+CRIS:[0-1]/
      }).then((result) => result.split(',')[1][0] as unknown as RingIndicationStatus)
    }

    'AT+CSQ' = this.getSignalQuality
    async getSignalQuality ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SignalQuality> {
      return this.#execute({
        text: 'AT+CSQ',
        description: 'Querying the signal quality',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+CSQ:/
      }).then((result) => result.split(':')[1] as unknown as SignalQuality)
    }

    'AT+CSQF' = this.getSignalQualityFast
    async getSignalQualityFast ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SignalQuality> {
      return this.#execute({
        text: 'AT+CSQF',
        description: 'Querying the last known calculated signal quality',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+CSQF:/
      }).then((result) => result.split(':')[1] as unknown as SignalQuality)
    }

    'AT+CULK' = this.unlockDevice
    async unlockDevice ({ unlockKey, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { unlockKey: string, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: 'AT+CULK=' + unlockKey,
        description: 'Attempting to unlock the device',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+CULK:[0-2]/
      }).then((result) => {
        const status = result.split(':')[1] as unknown as LockStatus
        switch (status) {
          case 0:
            return
          case 1:
            throw Error('Unlock key was not correct')
          case 2:
            throw Error('Device is permanently locked')
        }
      })
    }

    'AT+CULK?' = this.getLockStatus
    async getLockStatus ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<LockStatus> {
      return this.#execute({
        text: 'AT+CULK?',
        description: 'Querying the lock status',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+CULK:[0-2]/
      }).then((result) => result.split(':')[1] as unknown as LockStatus)
    }

    'AT+IPR=' = this.setFixedDTERate
    async setFixedDTERate ({ baudRate, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { baudRate: BaudRate, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: `AT+IPR=${baudRate}`,
        description: `Updating the fixed DTE rate to ${BaudRate[baudRate]}`,
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDWB=' = this.writeBinaryShortBurstData
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

            if (isNaN(code) || code > 0) {
              reject(Error(`Error writing binary message to buffer. ${description}`))
            }

            resolve()
          })
          .catch((error) => {
            reject(Error(`Error writing binary message to buffer. ${error}`))
          })
      })
    }

    'AT+SBDRB' = this.readShortBurstBinaryData
    async readShortBurstBinaryData ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDRB',
        description: 'Reading short burst binary data from the MT buffer',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDWT=' = this.writeShortBurstTextData
    async writeShortBurstTextData ({ text, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { text: string, timeoutMs?: number }): Promise<void> {
      return this.#execute({
        text: 'AT+SBDWT=' + text,
        description: 'Writing short burst text data to buffer',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDRT' = this.readShortBurstTextData
    async readShortBurstTextData ({ timeoutMs = INDEFINITE_TIMEOUT }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+SBDRT',
        description: 'Reading short burst text data from the MT buffer',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^(?!\+SBDRT:).+/
      })
        .then((message) => {
          this.#logger.info('Received new message: ' + message)
          this.emit('inbound-message', message)
          return message
        }).finally(() => this.clearMTBuffer())
    }

    'AT+SBDDET' = this.detatch
    async detatch ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDDET',
        description: 'Requesting the transciever stop receving ring alerts from the gateway (detach operation)',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDDET:[0-1],[0-99]/
      })
        .then((result) => {
          const data = result.match(/\+SBDDET:(\d+),(\d+)/)
          if (data) {
            const detStatus = parseInt(data[1])
            const detErrorCode = parseInt(data[2])
            const detErrorText = lookupDetachError(detErrorCode)

            if (detStatus === 0) {
              // success
              return
            }

            this.#logger.info('Error occured when attempting to detatch from the GSS: ' + detErrorText)
            throw new SBDSessionError('Unable to detatch from the GSS: ' + detErrorText)
          } else {
            throw new SBDSessionError(`Unexpected SBDDET response: ${result}`)
          }
        })
    }

    'AT+SBDIXA' = this.initiateSessionExtended
    async initiateSessionExtended ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SBDSessionResponse> {
      return this.#execute({
        text: 'AT+SBDIXA',
        description: 'Initiating SBD session',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDIX:.+/
      })
        .then((result) => {
          const data = result.match(/\+SBDIX: (\d+), (\d+), (\d+), (\d+), (\d+), (\d+)/)

          if (data) {
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
              return this.readShortBurstTextData().then(() => response)
            } else if (mtStatus === 2) {
              // TODO: If failOnMailboxCheckError --> Throw Error?
              return response
            }
          } else {
            throw new SBDSessionError(`Unexpected SBDIX response: ${result}`)
          }
        })
    }

    'AT+SBDMTA?' = this.getRingAlertEnabled
    async getRingAlertEnabled ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<boolean> {
      return this.#execute({
        text: 'AT+SBDMTA?',
        description: 'Querying ring indication mode',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDMTA:[0-1]/
      }).then((result) => {
        return result.split(':')[0] === '1'
      })
    }

    'AT+SBDMTA=0' = this.ringAlertDisable
    async ringAlertDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDMTA=0',
        description: 'Disabling ring alert',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDMTA=1' = this.ringAlertEnable
    async ringAlertEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDMTA=1',
        description: 'Enabling ring alert',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDREG?' = this.getNetworkRegistrationStatus
    async getNetworkRegistrationStatus ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<NetworkRegistrationStatus> {
      return this.#execute({
        text: 'AT+SBDREG?',
        description: 'Querying SBD network registration status',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDREG:[0-3]/
      }).then((result) => {
        return result.split(':')[1] as unknown as number
      })
    }

    'AT+SBDREG' = this.initiateNetworkRegistration
    async initiateNetworkRegistration ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDREG',
        description: 'Initiating SBD network registration',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDREG:[0-3],[0-99]/
      }).then((result) => {
        const data = result.match(/\+SBDREG:(\d+),(\d+)/)

        if (data) {
          // const status = parseInt(data[1])
          const error = parseInt(data[2])

          if (error !== 2) {
            throw Error('Error occured with network registration')
          }
        } else {
          throw new SBDSessionError(`Unexpected SBDIX response: ${result}`)
        }
      })
    }

    'AT+SBDAREG=0' = this.autoRegistrationDisable
    async autoRegistrationDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDAREG=0',
        description: 'Disabling automatic registration',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDAREG=1' = this.autoRegistrationEnable
    async autoRegistrationEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDAREG=1',
        description: 'Enabling automatic registration',
        timeoutMs,
        successRegex: OK_REGEXP
      }).then()
    }

    'AT+SBDD0' = this.clearMOBuffer
    async clearMOBuffer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD0',
        description: 'Clearing MO buffer',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^[0-1]/
      }).then((result) => {
        if (result === '1') throw Error('An error occured while clearing the buffer')
      })
    }

    'AT+SBDD1' = this.clearMTBuffer
    async clearMTBuffer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD1',
        description: 'Clearing MT buffer',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^[0-1]/
      }).then((result) => {
        if (result === '1') throw Error('An error occured while clearing the buffer')
      })
    }

    'AT+SBDD2' = this.clearBuffers
    async clearBuffers ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDD2',
        description: 'Clearing MO/MT buffers',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^[0-1]/
      }).then((result) => {
        if (result === '1') throw Error('An error occured while clearing the buffers')
      })
    }

    'AT+SBDC' = this.resetMOMSN
    async resetMOMSN ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
      return this.#execute({
        text: 'AT+SBDC',
        description: 'Resetting the MOMSN to 0',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^[0-1]/
      }).then((result) => {
        if (result === '1') throw Error('An error occured while clearing the MOMSN')
      })
    }

    'AT+SBDS' = this.getShortBurstDataStatus
    async getShortBurstDataStatus ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SBDStatusResponse> {
      return this.#execute({
        text: 'AT+SBDS',
        description: 'Querying the short burst data status',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDS:/
      }).then((result) => {
        const data = result.match(/\+SBDS: (\d+), (\d+), (\d+), (-?\d+)/)

        if (data) {
          const moFlag = parseInt(data[1])
          const moSeqNo = parseInt(data[2])
          const mtFlag = parseInt(data[3])
          const mtSeqNo = parseInt(data[4])

          return {
            moMessageInBuffer: !!moFlag,
            moMessageSequenceNumber: moSeqNo,
            mtMessageInBuffer: !!mtFlag,
            mtMessageSequenceNumber: mtSeqNo
          }
        } else {
          throw new Error(`Unexpected SBDS response: ${result}`)
        }
      })
    }

    'AT+SBDSX' = this.getShortBurstDataStatusExtended
    async getShortBurstDataStatusExtended ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SBDStatusExtendedResponse> {
      return this.#execute({
        text: 'AT+SBDSX',
        description: 'Querying the short burst data status',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDSX:/
      }).then((result) => {
        const data = result.match(/\+SBDSX: (\d+), (\d+), (-?\d+), (\d+), (\d+), (\d+)/)

        if (data) {
          const moFlag = parseInt(data[1])
          const moSeqNo = parseInt(data[2])
          const mtFlag = parseInt(data[3])
          const mtSeqNo = parseInt(data[4])
          const ringAlertFlag = parseInt(data[5])
          const messagesWaiting = parseInt(data[6])

          return {
            moMessageInBuffer: !!moFlag,
            moMessageSequenceNumber: moSeqNo,
            mtMessageInBuffer: !!mtFlag,
            mtMessageSequenceNumber: mtSeqNo,
            unansweredRingAlert: !!ringAlertFlag,
            messagesWaitingCount: messagesWaiting
          }
        } else {
          throw new Error(`Unexpected SBDSX response: ${result}`)
        }
      })
    }

    'AT+SBDTC' = this.transferMOBufferToMTBuffer
    async transferMOBufferToMTBuffer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<number> {
      return this.#execute({
        text: 'AT+SBDTC',
        description: 'Transferring MO Buffer to MT Buffer',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: ANY_REGEXP
        // eg. SBDTC: Outbound SBD Copied to Inbound SBD: size = 123
      }).then((result) => result.split('size = ')[1] as unknown as number)
    }

    'AT+SBDGW' = this.getIridiumGatewayType
    async getIridiumGatewayType ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
      return this.#execute({
        text: 'AT+SBDGW',
        description: 'Querying the Iridium gateway type (EMSS or non-EMSS)',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^\+SBDGW:/
      }).then((result) => result.split(': ')[1])
    }

    'AT-MSSTM' = this.getLatestNetworkSystemTime
    async getLatestNetworkSystemTime ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<Date> {
      return this.#execute({
        text: 'AT-MSSTM',
        description: 'Querying the latest network time from network',
        timeoutMs,
        successRegex: OK_REGEXP,
        bufferRegex: /^-MSSTM:/
      }).then((result) => {
        const time = result.split(': ')[1]
        if (time === 'no network service') {
          throw Error('The 9602 has not yet received system time from the network')
        }

        const iridiumEpoch = new Date('2007-03-08T03:50:35').getTime()
        return new Date(iridiumEpoch + parseInt(time))
      })
    }

    async mailboxCheck ({ signalQuality = SignalQuality.ONE, timeoutMs = INDEFINITE_TIMEOUT }:
      { signalQuality?: SignalQuality, timeoutMs?: number } = {}): Promise<void> {
      this.#logger.info('Performing mailbox check')
      return this.sendTextMessage('', { signalQuality, timeoutMs, compressed: false }).then()
    }

    async sendBinaryMessage (message: Buffer, { signalQuality = SignalQuality.ONE, timeoutMs = INDEFINITE_TIMEOUT }:
      { signalQuality?: SignalQuality, timeoutMs?: number }): Promise<SBDSessionResponse> {
      return new Promise((resolve, reject) => {
      // TODO: add timeout function. will need to add
      // new class property sessionInProgress to prevent
      // a timeout during session.
        this.writeBinaryShortBurstData({ buffer: message })
          .then(() => this.waitForNetwork({ signalQuality }))
          .then(() => this.initiateSessionExtended())
          .then((result) => {
            this.clearMOBuffer()
              .then(() => resolve(result))
              .catch((error) => reject(error))
          })
          .catch((error) => reject(error))
      })
    }

    async sendTextMessage (message: string, { signalQuality = SignalQuality.ONE, compressed = false, timeoutMs = INDEFINITE_TIMEOUT }:
        { signalQuality?: SignalQuality, compressed?: boolean, timeoutMs?: number }): Promise<SBDSessionResponse> {
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
        this.writeShortBurstTextData({ text: compressedBuffer ? compressedBuffer.toString('utf-8') : message })
          .then(() => this.waitForNetwork({ signalQuality }))
          .then(() => this.initiateSessionExtended())
          .then((result) => {
            this.clearMOBuffer()
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
function lookupDetachError (code: number) {
  switch (code) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      return 'Detatch successfully performed'
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 14:
    case 15:
      return 'An error occured while attempting the detatch'
    case 16:
      return 'Transceiver has been locked and may not make SBD calls (see +CULK command)'
    case 17:
      return 'Gateway not responding (local session timeout)'
    case 18:
      return 'Connection lost (RF drop)'
    case 19:
    case 20:
    case 21:
    case 22:
    case 23:
    case 24:
    case 25:
    case 26:
    case 27:
    case 28:
    case 29:
    case 30:
    case 31:
      return 'An error occured while attempting the detatch'
    case 32:
      return 'No network service, unable to initiate call'
    case 33:
      return 'Antenna fault, unable to initiate call'
    case 34:
      return 'Radio is disabled, unable to initiate call (see *Rn command)'
    case 35:
      return 'Transceiver is busy, unable to initiate call (typically performing auto-registration)'
    case 36:
      return 'An error occured while attempting the detatch'
    default:
      return 'Unknown response code received from the device'
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