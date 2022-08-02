import { TypedEmitter } from 'tiny-typed-emitter'
import { SerialPortController } from 'serialport-synchronous'
import { compress } from './utils'
import { SBDSessionError } from './error'
import {
  LogEvent, LogLevel, BaudRate, ConfigProfile, LockStatus,
  NetworkRegistrationStatus, RingIndicationStatus, SBDSessionResponse,
  SBDStatusExtendedResponse, SBDStatusResponse, SignalQuality
} from './types'

const OK_REGEXP = /^OK$/
const ANY_REGEXP = /^.+/
const ERROR_REGEXP = /^ERROR$/
const SBDRING_REGEXP = /^SBDRING$/
const DEFAULT_SIMPLE_TIMEOUT_MS = 2000
const DEFAULT_LONG_TIMEOUT_MS = 30000
const DEFAULT_SESSION_TIMEOUT_MS = 60000
const INDEFINITE_TIMEOUT = -1

export interface IridiumControllerInterface {
  'log': (message: LogEvent) => void
  'inbound-message': (message: Buffer) => void
  'ring-alert': () => void
}

export class IridiumController extends TypedEmitter<IridiumControllerInterface> {
  #controller: SerialPortController
  constructor (options?: { path: string; baudRate: number }) {
    super()
    this.#controller = new SerialPortController({
      ...options,
      handlers: [{
        pattern: SBDRING_REGEXP,
        callback: () => {
          this.#logger.debug('Received SBD ring alert, emitting ring-alert event')
          this.emit('ring-alert')
        }
      }]
    })

    this.#controller.on('log', log => this.#logger[log.level.toLowerCase()](log.message))
  }

  /**
   * Logger object to control output from the controller.
   * Log messages are created as {LogEvent} objects and
   * emitted through the 'log' event.
   */
  #logger = {
    debug: (message: string) => this.#logger.log(LogLevel.DEBUG, message),
    info: (message: string) => this.#logger.log(LogLevel.INFO, message),
    warn: (message: string) => this.#logger.log(LogLevel.WARN, message),
    error: (message: string) => this.#logger.log(LogLevel.ERROR, message),
    critical: (message: string) => this.#logger.log(LogLevel.CRITICAL, message),
    log: (level: LogLevel, message: string) => this.emit('log', { level, datetime: new Date(), message })
  }

  async init (): Promise<void> {
    return new Promise((resolve, reject) => {
      this.open()
        .then(() => this.flowControlDisable())
        .then(() => this.echoOff())
        .then(() => this.indicatorEventReportingDisable())
        .then(() => this.clearBuffers())
        .then(() => this.autoRegistrationEnable())
        .then(() => this.ringAlertEnable())
        .then(() => this.getRingIndicationStatus())
        .then(() => {
          resolve()
        })
        .catch((error) => reject(error))
    })
  }

  async open () {
    return this.#controller.open()
  }

  async close () {
    return this.#controller.close()
  }

  'ATE0' = this.echoOff
  async echoOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'ATE0',
      description: 'Turning echo off',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'ATE1' = this.echoOn
  async echoOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'ATE1',
      description: 'Turning echo on',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'ATI3' = this.getSoftwareRevisionLevel
  async getSoftwareRevisionLevel ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'ATI3',
      description: 'Querying the software revision level',
      timeoutMs,
      bufferRegex: ANY_REGEXP,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'ATI4' = this.getProductDescription
  async getProductDescription ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'ATI4',
      description: 'Querying the product description',
      timeoutMs,
      bufferRegex: ANY_REGEXP,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'ATI7' = this.getHardwareSpecification
  async getHardwareSpecification ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'ATI7',
      description: 'Querying the hardware specification',
      timeoutMs,
      bufferRegex: ANY_REGEXP,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'ATQ0' = this.quietModeOff
  async quietModeOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'ATQ0',
      description: 'Turning quiet mode off. 9602 responses will be sent to the DTE',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  // Removed as quiet mode needs to be disabled for the library to work
  /*
  'ATQ1' = this.quietModeOn
  async quietModeOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      requestData: 'ATQ1',
      description: 'Turning quiet mode on. 9602 responses will not be sent to the DTE',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }
  */

  // Removed as verbose mode needs to be enabled for the library to work
  /*
  'ATV0' = this.verboseModeOff
  async verboseModeOff ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      requestData: 'ATV0',
      description: 'Turning verbose mode off (textual responses disabled)',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }
  */

  'ATV1' = this.verboseModeOn
  async verboseModeOn ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'ATV1',
      description: 'Turning verbose mode on (textual responses enabled)',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'ATZn' = this.restoreUserConfig
  async restoreUserConfig ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: `ATZ${profile}`,
      description: `Soft reset. Restoring user configuration ${profile}`,
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT&F0' = this.restoreFactorySettings
  async restoreFactorySettings ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT&F0',
      description: 'Restoring factory settings',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT&K0' = this.flowControlDisable
  async flowControlDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT&K0',
      description: 'Disabling RTS/CTS flow control',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT&K3' = this.flowControlEnable
  async flowControlEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT&K3',
      description: 'Enabling RTS/CTS flow control',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT&V' = this.getActiveStoredConfig
  async getActiveStoredConfig ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT&V',
      description: 'Retrieving active and stored configuration profiles',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
    // TODO: Parse this into an object
  }

  'AT&Wn' = this.saveActiveConfig
  async saveActiveConfig ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: `AT&W${profile}`,
      description: `Storing current (active) configuration as profile ${profile}`,
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT&Yn' = this.designateDefaultResetProfile
  async designateDefaultResetProfile ({ profile, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { profile: ConfigProfile, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: `AT&Y${profile}`,
      description: `Setting profile ${profile} as default power up configuration`,
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT%R' = this.getSRegisters
  async getSRegisters ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT%R',
      description: 'Retrieving the system S-Registers',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
    // TODO: Parse these into an array of objects.
  }

  'AT*F' = this.prepareForShutdown
  async prepareForShutdown ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT*F',
      description: 'Preparing for power down. Radio will be disabled and all pending writes flushed to the EEPROM',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT*R0' = this.radioActivityDisable
  async radioActivityDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT*R0',
      description: 'Disabling radio activity',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT*R1' = this.radioActivityEnable
  async radioActivityEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT*R1',
      description: 'Enabling radio activity',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+CCLK' = this.getIridiumSystemTime
  async getIridiumSystemTime ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+CCLK',
      description: 'Querying the Iridium system time if available',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'AT+CGMI' = this.getDeviceManufacturer
  async getDeviceManufacturer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+CGMI',
      description: 'Querying the device manufacturer',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'AT+CGMM' = this.getDeviceModel
  async getDeviceModel ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+CGMM',
      description: 'Querying the device model',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  'AT+CGMR' = this.getDeviceModelRevision
  async getDeviceModelRevision ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+CGMR',
      description: 'Querying the device model revision',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
    // TODO: Parse response into object.
  }

  'AT+CGSN' = this.getDeviceSerialNumber
  async getDeviceSerialNumber ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+CGSN',
      description: 'Querying the device serial number',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: ANY_REGEXP,
      errorRegex: ERROR_REGEXP
    })
  }

  async waitForNetwork ({ signalQuality = SignalQuality.ONE, timeoutMs = INDEFINITE_TIMEOUT }: { signalQuality?: SignalQuality, timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+CIER=1,1,0,0',
      description: `Turning network signal monitoring on. Waiting for signal quality of ${signalQuality}`,
      timeoutMs,
      successRegex: new RegExp(`^\\+CIEV:0,[${signalQuality}-6]`),
      errorRegex: ERROR_REGEXP
    }).then(() => this.indicatorEventReportingDisable())
  }

  'AT+CIER=1,1,0,0' = this.signalMonitoringEnable
  async signalMonitoringEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    // TODO: This may conflict with serviceAvailabilityMonitoringEnable
    return this.#controller.regexRequest({
      data: 'AT+CIER=1,1,0,0',
      description: 'Turning network signal monitoring on',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+CIER=1,0,1,0' = this.serviceAvailabilityMonitoringEnable
  async serviceAvailabilityMonitoringEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    // TODO: This may conflict with signalMonitoringEnable
    return this.#controller.regexRequest({
      data: 'AT+CIER=1,0,1,0',
      description: 'Turning service availability monitoring on',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+CIER=1,0,0,0' = this.indicatorEventReportingDisable
  async indicatorEventReportingDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    // TODO: This may conflict with signalMonitoringEnable
    return this.#controller.regexRequest({
      data: 'AT+CIER=1,0,0,0',
      description: 'Turning indicator event monitoring off',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+CRIS' = this.getRingIndicationStatus
  async getRingIndicationStatus ({ notifyAlert = true, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { notifyAlert?: boolean, timeoutMs?: number } = {}): Promise<RingIndicationStatus> {
    return this.#controller.regexRequest({
      data: 'AT+CRIS',
      description: 'Querying the ring indication status',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+CRIS:[0-1]{3},[0-1]{3}/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      const status = parseInt(result.split(',')[1]) as RingIndicationStatus
      if (notifyAlert && status === RingIndicationStatus.RING_ALERT_RECEIVED) {
        this.#logger.debug('Unanswered SBD ring alert, emitting ring-alert event')
        this.emit('ring-alert')
      }
      return status
    })
  }

  'AT+CSQ' = this.getSignalQuality
  async getSignalQuality ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SignalQuality> {
    return this.#controller.regexRequest({
      data: 'AT+CSQ',
      description: 'Querying the signal quality',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+CSQ:/,
      errorRegex: ERROR_REGEXP
    }).then((result) => parseInt(result.split(':')[1]) as SignalQuality)
  }

  'AT+CSQF' = this.getSignalQualityFast
  async getSignalQualityFast ({ timeoutMs = DEFAULT_LONG_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SignalQuality> {
    return this.#controller.regexRequest({
      data: 'AT+CSQF',
      description: 'Querying the last known calculated signal quality',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+CSQF:/,
      errorRegex: ERROR_REGEXP
    }).then((result) => parseInt(result.split(':')[1]) as SignalQuality)
  }

  'AT+CULK' = this.unlockDevice
  async unlockDevice ({ unlockKey, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { unlockKey: string, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+CULK=' + unlockKey,
      description: 'Attempting to unlock the device',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+CULK:[0-2]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      const status = parseInt(result.split(':')[1]) as LockStatus
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
    return this.#controller.regexRequest({
      data: 'AT+CULK?',
      description: 'Querying the lock status',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+CULK:[0-2]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => parseInt(result.split(':')[1]) as LockStatus)
  }

  'AT+IPR=' = this.setFixedDTERate
  async setFixedDTERate ({ baudRate, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { baudRate: BaudRate, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: `AT+IPR=${baudRate}`,
      description: `Updating the fixed DTE rate to ${BaudRate[baudRate]}`,
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
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
      this.#controller.regexRequest({
        data: 'AT+SBDWB=' + buffer.length,
        description: 'Initiating start of binary data write to the buffer',
        timeoutMs,
        successRegex: /^READY/,
        errorRegex: ERROR_REGEXP
      })
        .then(() => {
          return this.#controller.regexRequest({
            data: output,
            description: 'Writing binary data to the buffer',
            timeoutMs: INDEFINITE_TIMEOUT,
            successRegex: /^[0-3]/,
            bufferRegex: /^[0-3]/,
            errorRegex: ERROR_REGEXP
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
  async readShortBurstBinaryData ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<Buffer> {
    return this.#controller.binaryRequest({
      data: 'AT+SBDRB',
      description: 'Reading short burst binary data from the MT buffer',
      interval: 300,
      maxBufferSize: 274
    })
      .then((buffer) => {
        const messageLength = buffer.readUInt16BE(0)
        const message = buffer.subarray(2, messageLength + 2)
        this.#logger.info('Received new message: [BINARY] ' + message.toString('hex'))
        this.emit('inbound-message', message)
        return buffer
      }).finally(() => this.clearMTBuffer())
  }

  'AT+SBDWT=' = this.writeShortBurstTextData
  async writeShortBurstTextData ({ text, timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { text: string, timeoutMs?: number }): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDWT=' + text,
      description: 'Writing short burst text data to buffer',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+SBDRT' = this.readShortBurstTextData
  async readShortBurstTextData ({ timeoutMs = INDEFINITE_TIMEOUT }: { timeoutMs?: number } = {}): Promise<Buffer> {
    return this.#controller.regexRequest({
      data: 'AT+SBDRT',
      description: 'Reading short burst text data from the MT buffer',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^(?!\+SBDRT:|OK\s?$).+/,
      errorRegex: ERROR_REGEXP
    })
      .then((message) => {
        const buffer = Buffer.from(message)
        this.#logger.info('Received new message: ' + message)
        this.emit('inbound-message', buffer)
        return buffer
      }).finally(() => this.clearMTBuffer())
  }

  'AT+SBDDET' = this.detatch
  async detatch ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDDET',
      description: 'Requesting the transciever stop receving ring alerts from the gateway (detach operation)',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDDET:[0-1],[0-99]/,
      errorRegex: ERROR_REGEXP
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
    return this.#controller.regexRequest({
      data: 'AT+SBDIXA',
      description: 'Initiating SBD session',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDIX:.+/,
      errorRegex: ERROR_REGEXP
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
            return this.readShortBurstBinaryData().then(() => response)
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
    return this.#controller.regexRequest({
      data: 'AT+SBDMTA?',
      description: 'Querying ring indication mode',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDMTA:[0-1]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      return result.split(':')[0] === '1'
    })
  }

  'AT+SBDMTA=0' = this.ringAlertDisable
  async ringAlertDisable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDMTA=0',
      description: 'Disabling ring alert',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+SBDMTA=1' = this.ringAlertEnable
  async ringAlertEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDMTA=1',
      description: 'Enabling ring alert',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+SBDREG?' = this.getNetworkRegistrationStatus
  async getNetworkRegistrationStatus ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<NetworkRegistrationStatus> {
    return this.#controller.regexRequest({
      data: 'AT+SBDREG?',
      description: 'Querying SBD network registration status',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDREG:[0-3]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      return result.split(':')[1] as unknown as number
    })
  }

  'AT+SBDREG' = this.initiateNetworkRegistration
  async initiateNetworkRegistration ({ timeoutMs = DEFAULT_SESSION_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDREG',
      description: 'Initiating SBD network registration',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDREG:[0-3],[0-99]/,
      errorRegex: ERROR_REGEXP
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
    return this.#controller.regexRequest({
      data: 'AT+SBDAREG=0',
      description: 'Disabling automatic registration',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+SBDAREG=1' = this.autoRegistrationEnable
  async autoRegistrationEnable ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDAREG=1',
      description: 'Enabling automatic registration',
      timeoutMs,
      successRegex: OK_REGEXP,
      errorRegex: ERROR_REGEXP
    }).then()
  }

  'AT+SBDD0' = this.clearMOBuffer
  async clearMOBuffer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDD0',
      description: 'Clearing MO buffer',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^[0-1]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      if (result === '1') throw Error('An error occured while clearing the buffer')
    })
  }

  'AT+SBDD1' = this.clearMTBuffer
  async clearMTBuffer ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDD1',
      description: 'Clearing MT buffer',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^[0-1]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      if (result === '1') throw Error('An error occured while clearing the buffer')
    })
  }

  'AT+SBDD2' = this.clearBuffers
  async clearBuffers ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDD2',
      description: 'Clearing MO/MT buffers',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^[0-1]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      if (result === '1') throw Error('An error occured while clearing the buffers')
    })
  }

  'AT+SBDC' = this.resetMOMSN
  async resetMOMSN ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
    return this.#controller.regexRequest({
      data: 'AT+SBDC',
      description: 'Resetting the MOMSN to 0',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^[0-1]/,
      errorRegex: ERROR_REGEXP
    }).then((result) => {
      if (result === '1') throw Error('An error occured while clearing the MOMSN')
    })
  }

  'AT+SBDS' = this.getShortBurstDataStatus
  async getShortBurstDataStatus ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<SBDStatusResponse> {
    return this.#controller.regexRequest({
      data: 'AT+SBDS',
      description: 'Querying the short burst data status',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDS:/,
      errorRegex: ERROR_REGEXP
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
    return this.#controller.regexRequest({
      data: 'AT+SBDSX',
      description: 'Querying the short burst data status',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDSX:/,
      errorRegex: ERROR_REGEXP
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
    return this.#controller.regexRequest({
      data: 'AT+SBDTC',
      description: 'Transferring MO Buffer to MT Buffer',
      timeoutMs,
      successRegex: /^SBDTC:/,
      bufferRegex: /^SBDTC:/,
      errorRegex: ERROR_REGEXP
      // eg. SBDTC: Outbound SBD Copied to Inbound SBD: size = 123
    }).then((result) => result.split('size = ')[1] as unknown as number)
  }

  'AT+SBDGW' = this.getIridiumGatewayType
  async getIridiumGatewayType ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<string> {
    return this.#controller.regexRequest({
      data: 'AT+SBDGW',
      description: 'Querying the Iridium gateway type (EMSS or non-EMSS)',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^\+SBDGW:/,
      errorRegex: ERROR_REGEXP
    }).then((result) => result.split(': ')[1])
  }

  'AT-MSSTM' = this.getLatestNetworkSystemTime
  async getLatestNetworkSystemTime ({ timeoutMs = DEFAULT_SIMPLE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<Date> {
    return this.#controller.regexRequest({
      data: 'AT-MSSTM',
      description: 'Querying the latest network time from network',
      timeoutMs,
      successRegex: OK_REGEXP,
      bufferRegex: /^-MSSTM:/,
      errorRegex: ERROR_REGEXP
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
