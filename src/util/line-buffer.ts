/**
 * Reassembles text that arrives in arbitrary BLE notification fragments into
 * complete lines. Accepts CR, LF or CRLF as terminators (CRLF split across two
 * notifications is handled too).
 */
export class LineBuffer {
  private pending = '';
  private lastWasCR = false;

  /** Feed a fragment; returns any lines completed by it (without terminators). */
  push(fragment: string): string[] {
    const lines: string[] = [];
    for (const ch of fragment) {
      if (ch === '\n') {
        if (this.lastWasCR) {
          this.lastWasCR = false; // second half of CRLF
          continue;
        }
        lines.push(this.pending);
        this.pending = '';
      } else if (ch === '\r') {
        lines.push(this.pending);
        this.pending = '';
        this.lastWasCR = true;
        continue;
      } else {
        this.pending += ch;
      }
      this.lastWasCR = false;
    }
    return lines;
  }

  /** Text received since the last terminator (e.g. a prompt with no newline). */
  get partial(): string {
    return this.pending;
  }

  /** Return and clear any unterminated text. */
  flush(): string {
    const p = this.pending;
    this.pending = '';
    this.lastWasCR = false;
    return p;
  }
}

/**
 * How long to wait before treating unterminated text as a complete line. The PS-LS-I4 sends long output in bursts
 * about 250–300 ms apart, sometimes mid-line, so this must be well above that and below the command idle timeout.
 */
export const PARTIAL_FLUSH_MS = 1000;

/**
 * LineBuffer plus a timer: emits complete lines as they arrive, and emits unterminated text (a prompt, or
 * "Correct Password" without a newline) once nothing more has arrived for `flushMs`.
 */
export class TimedLineBuffer {
  private buf = new LineBuffer();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly flushMs = PARTIAL_FLUSH_MS,
  ) {}

  push(text: string): void {
    for (const line of this.buf.push(text)) this.onLine(line);
    clearTimeout(this.timer);
    if (this.buf.partial) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Emit any unterminated text now and stop the timer. */
  flush(): void {
    clearTimeout(this.timer);
    const rest = this.buf.flush();
    if (rest) this.onLine(rest);
  }
}
