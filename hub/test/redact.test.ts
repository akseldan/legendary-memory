import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact';

describe('redact: removes secrets', () => {
  const secrets: [string, string][] = [
    ['OpenAI-style key', 'key sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD end'],
    ['Anthropic-style key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AWS key', 'AKIAABCDEFGHIJKLMNOP'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['Stripe key', 'sk_live_abcdefghijklmnopqrstuv'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'],
    ['Bearer token', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['password assignment', 'password = hunter2abc99'],
    ['quoted api_key', '"api_key": "abc123def456ghi"'],
    ['SSN', 'ssn 123-45-6789 here'],
    ['Visa test card', 'card 4111 1111 1111 1111 expires'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----'],
  ];
  for (const [label, input] of secrets) {
    it(label, () => {
      const out = redact(input);
      expect(out.count).toBeGreaterThan(0);
      expect(out.text).toContain('[REDACTED');
    });
  }
});

describe('redact: leaves ordinary text alone', () => {
  const safe: [string, string][] = [
    ['function call assignment', 'token = getToken()'],
    ['short password word', 'password = changeme'],
    ['prose', 'We decided to use PWM fans because they are quieter.'],
    ['phone-like number', 'call 253-555-0142 tomorrow'],
    ['order number that fails Luhn', 'order 1234 5678 9012 3456'],
    ['version string', 'node 22.11.0 and sk-learn is a library'],
    ['code with token attribute', 'const token = response.data.token;'],
  ];
  for (const [label, input] of safe) {
    it(label, () => {
      const out = redact(input);
      expect(out.count).toBe(0);
      expect(out.text).toBe(input);
    });
  }
});

describe('redact: counting', () => {
  it('counts each secret', () => {
    const out = redact('a sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD and 123-45-6789');
    expect(out.count).toBe(2);
  });
  it('is idempotent', () => {
    const once = redact('password = hunter2abc99').text;
    expect(redact(once)).toEqual({ text: once, count: 0 });
  });
});
