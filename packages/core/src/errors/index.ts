/**
 * Errors for VoiceMinusOne.
 *
 * All errors extend VoiceMinusOneError with a machine-readable `code`.
 * Never throw raw `Error()` — always use these structured errors.
 */

export type VoiceMinusOneErrorCode =
  | 'CORE_NOT_STARTED'
  | 'CORE_ALREADY_STARTED'
  | 'CORE_ALREADY_STOPPED'
  | 'PLUGIN_MISSING'
  | 'PLUGIN_INIT_FAILED'
  | 'PLUGIN_INVALID'
  | 'TRANSPORT_CONNECTION_FAILED'
  | 'TRANSPORT_DISCONNECTED'
  | 'TRANSPORT_SEND_FAILED'
  | 'STT_FAILED'
  | 'TTS_FAILED'
  | 'LLM_FAILED'
  | 'VAD_FAILED'
  | 'PIPELINE_ERROR'
  | 'SESSION_INVALID_STATE'
  | 'SESSION_CONFIG_INVALID'
  | 'WIRE_PROTOCOL_INVALID'
  | 'AUDIO_FORMAT_UNSUPPORTED'
  | 'TIMEOUT'
  | 'UNKNOWN'

export class VoiceMinusOneError extends Error {
  readonly code: VoiceMinusOneErrorCode
  readonly fatal: boolean

  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(`[${code}] ${message}`)
    this.name = 'VoiceMinusOneError'
    this.code = code
    this.fatal = fatal
  }
}

export class PluginError extends VoiceMinusOneError {
  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(code, message, fatal)
    this.name = 'PluginError'
  }
}

export class TransportError extends VoiceMinusOneError {
  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(code, message, fatal)
    this.name = 'TransportError'
  }
}

export class PipelineError extends VoiceMinusOneError {
  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(code, message, fatal)
    this.name = 'PipelineError'
  }
}

export class SessionError extends VoiceMinusOneError {
  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(code, message, fatal)
    this.name = 'SessionError'
  }
}

export class WireProtocolError extends VoiceMinusOneError {
  constructor(code: VoiceMinusOneErrorCode, message: string, fatal = false) {
    super(code, message, fatal)
    this.name = 'WireProtocolError'
  }
}
