// Made-up credentials for the tests that check the brain refuses to store secrets. Each one is joined at run time
// from pieces, so no source file holds a whole key-shaped string (public code scanners read those as committed
// secrets). The body is whatever the test wants after the prefix; the result is the same string a literal would be.

/** An Anthropic-style key: sk-ant-<body>. */
export const fakeAnthropicKey = (body: string): string => 'sk-' + 'ant-' + body;

/** An OpenAI-style key: sk-<body>. */
export const fakeSkKey = (body: string): string => 'sk-' + body;

/** A GitHub token: ghp_<body>. */
export const fakeGithubToken = (body: string): string => 'gh' + 'p_' + body;

/** An AWS access key id: AKIA<body>. */
export const fakeAwsKey = (body: string): string => 'AKI' + 'A' + body;

/** A PEM private key header, e.g. fakePrivateKeyHeader('RSA'). */
export const fakePrivateKeyHeader = (kind = ''): string => '-----' + 'BEGIN ' + (kind ? kind + ' ' : '') + 'PRIVATE ' + 'KEY-----';

/** A JWT-shaped token (also the shape of a Cloudflare tunnel token's start): eyJ<header>.<payload>.<signature>. */
export const fakeJwt = (): string => 'ey' + 'J' + 'hIjoiYWJjZGVmZ2hpams' + '.' + 'eyJzdWIiOiJ4eHh4eHh4eHh4' + '.' + 'abc';

/** A live-mode style key: sk-live-<body>. */
export const fakeSkLiveKey = (body: string): string => 'sk-' + 'live-' + body;
