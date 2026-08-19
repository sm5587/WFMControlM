import {
  REDACTED,
  redactString,
  redactValue,
  scrubRemoteLogLines,
} from '../../src/utils/log-redaction';

describe('log-redaction', () => {
  it('redacts JWT tokens in strings', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxIn0.signature';
    expect(redactString(`token=${token}`)).toBe(`token=${REDACTED}`);
  });

  it('redacts Bearer authorization headers', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  it('redacts JDBC URLs with embedded credentials', () => {
    const input = 'connect jdbc:db2://dbuser:dbpass@host:50030/RWS4 failed';
    expect(redactString(input)).toBe(`connect jdbc:db2://${REDACTED}@host:50030/RWS4 failed`);
  });

  it('redacts password key-value pairs', () => {
    expect(redactString('login failed password=SuperSecret123')).toBe(
      `login failed password=${REDACTED}`,
    );
  });

  it('redacts sensitive object keys', () => {
    const result = redactValue({
      username: 'operator',
      db2Password: 'plain-text',
      nested: { smtpPass: 'mail-secret' },
    });
    expect(result).toEqual({
      username: 'operator',
      db2Password: REDACTED,
      nested: { smtpPass: REDACTED },
    });
  });

  it('redacts env-style secret assignments', () => {
    expect(redactString('DB2_PASS_OVERRIDE=MyDbPass CONFIG_ENCRYPTION_KEY=abc123')).toBe(
      `DB2_PASS_OVERRIDE=${REDACTED} CONFIG_ENCRYPTION_KEY=${REDACTED}`,
    );
  });

  it('scrubs remote log lines', () => {
    const lines = scrubRemoteLogLines([
      'Starting batch',
      'password=hidden-value in cron output',
      'done',
    ]);
    expect(lines[1]).toBe(`password=${REDACTED} in cron output`);
  });
});
