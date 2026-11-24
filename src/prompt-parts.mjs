// Context that plugins (src/plugins) add to a conversation's turn, after its knowledge folders.
// Each part is told the conversation, whether its native session resumes and whether it is a desk,
// and returns text or ''. A part that fails is left out rather than stopping the turn.
export class PromptParts {
  constructor() { this.parts = new Set(); }
  add(part) { this.parts.add(part); return () => this.parts.delete(part); }
  async text(info) {
    let out = '';
    for (const part of [...this.parts]) {
      try { const value = await part(info); if (typeof value === 'string') out += value; } catch {}
    }
    return out;
  }
}
