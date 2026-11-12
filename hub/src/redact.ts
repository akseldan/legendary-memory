/**
 * Strips credentials out of text before it is stored.
 *
 * Memory is read back into AI conversations, so a secret saved once would be replayed
 * into every future chat that touches it. Everything written to the hub passes through
 * here first. It is a safety net, not a guarantee: it catches well-known formats.
 */

export interface Redacted {
  text: string;
  /** How many secrets were replaced. */
  count: number;
}

interface Rule {
  label: string;
  pattern: RegExp;
  /** Return the replacement, or null to leave this match alone. */
  replace?: (match: string, ...groups: string[]) => string | null;
}

const RULES: Rule[] = [
  { label: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'api-key', pattern: /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { label: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'stripe-key', pattern: /\b[spr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'bearer-token', pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{24,}=*/g, replace: (_m, word) => `${word} [REDACTED:bearer-token]` },
  {
    // password = hunter2abc, "api_key": "abc123...". The value must look like a secret
    // (letters and digits, 8+ chars) so ordinary code such as `token = getToken()` is left alone.
    label: 'secret',
    pattern:
      /\b((?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{8,})/gi,
    replace: (_m, prefix, value) =>
      /[A-Za-z]/.test(value!) && /\d/.test(value!) && !/[.(]/.test(value!) && !value!.startsWith('[REDACTED')
        ? `${prefix}[REDACTED:secret]`
        : null,
  },
  { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    label: 'card-number',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    replace: (match) => (luhn(match.replace(/[ -]/g, '')) ? '[REDACTED:card-number]' : null),
  },
];

/** Luhn checksum: true for plausible payment card numbers. */
function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redact(input: string): Redacted {
  let count = 0;
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((part): part is string => typeof part === 'string').slice(0, -1);
      const replacement = rule.replace ? rule.replace(match, ...groups) : `[REDACTED:${rule.label}]`;
      if (replacement === null) return match;
      count++;
      return replacement;
    });
  }
  return { text, count };
}
