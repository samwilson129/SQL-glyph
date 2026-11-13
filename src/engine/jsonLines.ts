/** Decodes newline-delimited JSON from a byte/string stream. */
export class JsonLineDecoder {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      index = this.buffer.indexOf('\n');
    }
    return lines;
  }

  flush(): string[] {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder.length > 0 ? [remainder] : [];
  }

  get pending(): string {
    return this.buffer;
  }
}
