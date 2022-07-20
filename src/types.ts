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
