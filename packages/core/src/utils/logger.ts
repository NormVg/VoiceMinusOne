/**
 * Injectable logger — never use console.log in library code (R-007).
 *
 * All logging goes through the Logger interface with levels.
 * Format: [vm1:<namespace>] <message>
 */

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Silent = 4,
}

export interface Logger {
  debug(namespace: string, message: string, ...args: unknown[]): void
  info(namespace: string, message: string, ...args: unknown[]): void
  warn(namespace: string, message: string, ...args: unknown[]): void
  error(namespace: string, message: string, ...args: unknown[]): void
  setLevel(level: LogLevel): void
  child(namespace: string): Logger
}

export class ConsoleLogger implements Logger {
  private level: LogLevel = LogLevel.Info

  constructor(level: LogLevel = LogLevel.Info) {
    this.level = level
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  debug(namespace: string, message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.Debug) {
      console.debug(`[vm1:${namespace}] ${message}`, ...args)
    }
  }

  info(namespace: string, message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.Info) {
      console.info(`[vm1:${namespace}] ${message}`, ...args)
    }
  }

  warn(namespace: string, message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.Warn) {
      console.warn(`[vm1:${namespace}] ${message}`, ...args)
    }
  }

  error(namespace: string, message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.Error) {
      console.error(`[vm1:${namespace}] ${message}`, ...args)
    }
  }

  child(namespace: string): Logger {
    return new ChildLogger(this, namespace)
  }
}

class ChildLogger implements Logger {
  constructor(
    private parent: Logger,
    private prefix: string,
  ) {}

  debug(namespace: string, message: string, ...args: unknown[]): void {
    this.parent.debug(`${this.prefix}:${namespace}`, message, ...args)
  }

  info(namespace: string, message: string, ...args: unknown[]): void {
    this.parent.info(`${this.prefix}:${namespace}`, message, ...args)
  }

  warn(namespace: string, message: string, ...args: unknown[]): void {
    this.parent.warn(`${this.prefix}:${namespace}`, message, ...args)
  }

  error(namespace: string, message: string, ...args: unknown[]): void {
    this.parent.error(`${this.prefix}:${namespace}`, message, ...args)
  }

  setLevel(level: LogLevel): void {
    this.parent.setLevel(level)
  }

  child(namespace: string): Logger {
    return new ChildLogger(this, namespace)
  }
}

/** Silent logger for tests that don't care about output. */
export class SilentLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  setLevel(): void {}
  child(): Logger {
    return this
  }
}

/** The default logger instance. */
export const logger: Logger = new ConsoleLogger()
