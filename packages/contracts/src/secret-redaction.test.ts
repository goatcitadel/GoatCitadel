import { describe, expect, it } from "vitest";
import { redactSecretText, redactStructuredSecrets } from "./secret-redaction.js";

describe("redactSecretText", () => {
  it("redacts common provider, channel, and authorization secrets", () => {
    const result = redactSecretText(
      [
        "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz",
        "1234567890:AAH0123456789012345678901234567890abc",
        "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        "AKIAIOSFODNN7EXAMPLE",
        "Authorization: Bearer abc123def456ghi789jkl",
      ].join(" "),
    );

    expect(result.value).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] Authorization: [REDACTED]");
    expect(result.redactionCount).toBe(5);
  });

  it("preserves useful key and query structure while redacting values", () => {
    const result = redactSecretText(
      'api-key="abcDEF123._~+/" token: qwerty1234 https://example.test/hook?token=secret-token&ok=1',
    );

    expect(result.value).toBe('api-key="[REDACTED]" token: [REDACTED] https://example.test/hook?token=[REDACTED]&ok=1');
    expect(result.redactionCount).toBe(3);
  });

  it("redacts literal env values without redacting short or whitespace values", () => {
    const result = redactSecretText("custom=fcrl_abcdefghijklmnop short=abc spaced=two words", {
      env: {
        FIRECRAWL_API_KEY: "fcrl_abcdefghijklmnop",
        SHORT: "abc",
        SPACED: "two words",
      },
    });

    expect(result.value).toBe("custom=[REDACTED_ENV:FIRECRAWL_API_KEY] short=abc spaced=two words");
    expect(result.redactionCount).toBe(1);
  });

  it("redacts short values when an explicit credential key labels serialized text", () => {
    const result = redactSecretText('{"DATABASE_PASSWORD":"Tr0ub4dor&3","password":"p@ssw0rd!","visible":"ok"}');

    expect(result.value).toBe('{"DATABASE_PASSWORD":"[REDACTED]","password":"[REDACTED]","visible":"ok"}');
    expect(result.redactionCount).toBe(2);

    const assignments = redactSecretText("DATABASE_PASSWORD=Tr0ub4dor&3 password: p@ssw0rd!");
    expect(assignments.value).toBe("DATABASE_PASSWORD=[REDACTED] password: [REDACTED]");
    expect(assignments.redactionCount).toBe(2);

    const keyAssignments = redactSecretText(
      "auth=hunter2 authentication=hunter2 bearer=hunter2 cookie=hunter2 cookies=hunter2 " +
        "credential=hunter2 credentials=hunter2 clientKey=hunter2 accessKey=hunter2 privateKey=tiny-secret",
    );
    expect(keyAssignments.value).toBe(
      "auth=[REDACTED] authentication=[REDACTED] bearer=[REDACTED] cookie=[REDACTED] " +
        "cookies=[REDACTED] credential=[REDACTED] credentials=[REDACTED] clientKey=[REDACTED] " +
        "accessKey=[REDACTED] privateKey=[REDACTED]",
    );
    expect(keyAssignments.redactionCount).toBe(10);

    const escaped = redactSecretText('{\\"DATABASE_PASSWORD\\":\\"tiny\\",\\"visible\\":\\"ok\\"}');
    expect(escaped.value).toBe('{\\"DATABASE_PASSWORD\\":\\"[REDACTED]\\",\\"visible\\":\\"ok\\"}');
    expect(escaped.redactionCount).toBe(1);
  });

  it("preserves non-secret code expressions while redacting literal credential assignments", () => {
    const result = redactSecretText(
      [
        "const tokenBudget = 1000;",
        "const tokenCount = 5;",
        "const passwordPolicy = true;",
        "const accessToken = getToken();",
        'const apiKey = "literal-secret";',
        "password=hunter2",
        "password=1234",
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "const tokenBudget = 1000;",
        "const tokenCount = 5;",
        "const passwordPolicy = true;",
        "const accessToken = getToken();",
        'const apiKey = "[REDACTED]";',
        "password=[REDACTED]",
        "password=[REDACTED]",
      ].join("\n"),
    );
    expect(result.redactionCount).toBe(3);
  });

  it("preserves credential-shaped code declarations and references without preserving literal values", () => {
    const result = redactSecretText(
      [
        "type Login = { password: string };",
        "const password = process.env.PASSWORD;",
        "const apiKey = process.env.API_KEY;",
        'const bracketApiKey = process.env["API_KEY"];',
        'const denoApiKey = Deno.env.get("API_KEY");',
        'const pythonApiKey = os.getenv("API_KEY");',
        'const pythonBracketApiKey = os.environ["API_KEY"];',
        'const accessorApiKey = secrets.get("API_KEY");',
        'const awaitedApiKey = await secrets.get("API_KEY");',
        'const passwordFromAccessor = getSecret("db");',
        "const apiKeyAlias = secretReference;",
        "apiKey=$API_KEY",
        "apiKey=${API_KEY}",
        "const password = config.password;",
        "type GenericLogin = { password: SomeType<string> };",
        "type MappedLogin = { password: Record<string, string> };",
        "type FunctionLogin = { password: (() => string) };",
        "type InferredLogin = { password: z.infer<typeof schema> };",
        "type TypeofLogin = { apiKey: typeof config.apiKey };",
        "const passwordPolicy: PasswordPolicy = strict;",
        "interface Headers { Authorization: string; }",
        "const headers = { authorization: authHeader };",
        "const proxy = { proxyAuthorization: config.proxyAuthorization };",
        'const signingKey = "literal-signing-secret";',
        "const templatePassword = `hello world`;",
        "const templateApiKey = `secret-${tenant}`;",
        'const header = "Authorization: Token abcdef1234567890";',
        "const templateHeader = `Authorization: Custom one two three`;",
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "type Login = { password: string };",
        "const password = process.env.PASSWORD;",
        "const apiKey = process.env.API_KEY;",
        'const bracketApiKey = process.env["API_KEY"];',
        'const denoApiKey = Deno.env.get("API_KEY");',
        'const pythonApiKey = os.getenv("API_KEY");',
        'const pythonBracketApiKey = os.environ["API_KEY"];',
        'const accessorApiKey = secrets.get("API_KEY");',
        'const awaitedApiKey = await secrets.get("API_KEY");',
        'const passwordFromAccessor = getSecret("db");',
        "const apiKeyAlias = secretReference;",
        "apiKey=$API_KEY",
        "apiKey=${API_KEY}",
        "const password = config.password;",
        "type GenericLogin = { password: SomeType<string> };",
        "type MappedLogin = { password: Record<string, string> };",
        "type FunctionLogin = { password: (() => string) };",
        "type InferredLogin = { password: z.infer<typeof schema> };",
        "type TypeofLogin = { apiKey: typeof config.apiKey };",
        "const passwordPolicy: PasswordPolicy = strict;",
        "interface Headers { Authorization: string; }",
        "const headers = { authorization: authHeader };",
        "const proxy = { proxyAuthorization: config.proxyAuthorization };",
        'const signingKey = "[REDACTED]";',
        "const templatePassword = `[REDACTED]`;",
        "const templateApiKey = `[REDACTED]`;",
        'const header = "Authorization: [REDACTED]";',
        "const templateHeader = `Authorization: [REDACTED]`;",
      ].join("\n"),
    );
    expect(result.redactionCount).toBe(5);
  });

  it("preserves typed declarations while redacting cross-language literal initializers", () => {
    const result = redactSecretText(
      [
        'const apiKey: string = "literal-secret";',
        'const password: string = "hunter2";',
        'let token: string | undefined = "abcdef123456";',
        'password: str = "python-secret"',
        'let password: &str = "rust-secret";',
        'var token: String? = "kotlin-secret"',
        'password := "go-secret"',
        'password := "hunter2"',
        'const inlinePassword: string = "inline-secret"; const x = "safe";',
        'const firstPassword: string = "first-inline", secondToken: string = "second-inline";',
        'const accessorPassword: string = getSecret("db"); const y = "safe";',
        'const functionPassword: (() => string) = "function-secret";',
        'type Auth = { token: "bearer" | "basic" };',
        'type Login = { password: "required" | "optional" };',
        'type InlineAuth = { token: "bearer" | "basic" }; const safeAfterType = "safe";',
        'interface InlineLogin { password: "required" } const safeAfterInterface = "safe";',
        'enum AuthKind { token = "bearer", password = "required" }',
        'const enum KeyName { apiKey = "API_KEY" }',
        'type Token = "bearer" | "basic";',
        'type Password = "required" | "optional";',
        "type ApiKey = `key-${string}`;",
        'const runtime = { password: "object-secret" };',
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        'const apiKey: string = "[REDACTED]";',
        'const password: string = "[REDACTED]";',
        'let token: string | undefined = "[REDACTED]";',
        'password: str = "[REDACTED]"',
        'let password: &str = "[REDACTED]";',
        'var token: String? = "[REDACTED]"',
        'password := "[REDACTED]"',
        'password := "[REDACTED]"',
        'const inlinePassword: string = "[REDACTED]"; const x = "safe";',
        'const firstPassword: string = "[REDACTED]", secondToken: string = "[REDACTED]";',
        'const accessorPassword: string = getSecret("db"); const y = "safe";',
        'const functionPassword: (() => string) = "[REDACTED]";',
        'type Auth = { token: "bearer" | "basic" };',
        'type Login = { password: "required" | "optional" };',
        'type InlineAuth = { token: "bearer" | "basic" }; const safeAfterType = "safe";',
        'interface InlineLogin { password: "required" } const safeAfterInterface = "safe";',
        'enum AuthKind { token = "bearer", password = "required" }',
        'const enum KeyName { apiKey = "API_KEY" }',
        'type Token = "bearer" | "basic";',
        'type Password = "required" | "optional";',
        "type ApiKey = `key-${string}`;",
        'const runtime = { password: "[REDACTED]" };',
      ].join("\n"),
    );
    expect(result.redactionCount).toBe(13);
  });

  it("redacts arbitrary authorization schemes and encoded URL userinfo completely", () => {
    const result = redactSecretText(
      [
        "Authorization: Token abcdef1234567890",
        "Proxy-Authorization: Digest username=operator, response=abcdef1234567890",
        "Authorization: Custom one two three",
        "Authorization: Digest username=alice realm=private nonce=abc",
        "https://user:p%40ss:w0rd@example.test/path",
        "https://user:p@ss@example.test/path",
        "postgres://user:p@ss@db.example.test/name",
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "Authorization: [REDACTED]",
        "Proxy-Authorization: [REDACTED]",
        "Authorization: [REDACTED]",
        "Authorization: [REDACTED]",
        "https://[REDACTED]@example.test/path",
        "https://[REDACTED]@example.test/path",
        "postgres://[REDACTED]@db.example.test/name",
      ].join("\n"),
    );
    expect(result.value).not.toContain("abcdef1234567890");
    expect(result.value).not.toContain("p%40ss:w0rd");
  });

  it("redacts raw JSON authorization fields for arbitrary schemes", () => {
    const result = redactSecretText(
      '{"authorization":"Custom one two three","proxyAuthorization":"Digest username=operator nonce=abc"}',
    );

    expect(result.value).toBe('{"authorization":"[REDACTED]","proxyAuthorization":"[REDACTED]"}');
    expect(result.redactionCount).toBe(2);
  });

  it("redacts folded headers, YAML secret blocks, cookie headers, and separated CLI flags", () => {
    const result = redactSecretText(
      [
        "Authorization: Bearer\n hunter2",
        "Proxy-Authorization: Digest username=alice,\r\n response=abcdef1234567890",
        "Cookie: safe=abc; sessionid=hunter2; csrf=abcdef1234567890",
        "Set-Cookie: sessionid=hunter2; Path=/; HttpOnly",
        "apiKey: |\n  yaml-secret",
        "password: >\n  folded-secret",
        "credential: >-\n  first\n\n  blank-line-secret\nnext-field: safe",
        "privateKey: |\n  -----BEGIN PRIVATE KEY-----\n  private-key-body\n  -----END PRIVATE KEY-----",
        'curl --password hunter2 --api-key "api-secret" --signing-key signing-secret',
      ].join("\nnext\n"),
    );

    expect(result.value).toBe(
      [
        "Authorization: [REDACTED]",
        "Proxy-Authorization: [REDACTED]",
        "Cookie: [REDACTED]",
        "Set-Cookie: [REDACTED]",
        "apiKey: [REDACTED]",
        "password: [REDACTED]",
        "credential: [REDACTED]\nnext-field: safe",
        "privateKey: [REDACTED]",
        'curl --password [REDACTED] --api-key "[REDACTED]" --signing-key [REDACTED]',
      ].join("\nnext\n"),
    );
    expect(result.value).not.toContain("hunter2");
    expect(result.value).not.toContain("private-key-body");
    expect(result.redactionCount).toBe(11);
  });

  it("redacts credential flags in shell and argv forms while preserving references", () => {
    const result = redactSecretText(
      [
        "tool --api-key hunter2 --token=abcdef123456 --password $PASSWORD --access-key process.env.ACCESS_KEY",
        "tool -password tiny-secret -token ${TOKEN} -private-key $env:PRIVATE_KEY -consumer-key %CONSUMER_KEY%",
        "const args = ['--password', 'hunter2', '--token', 'abcdef123456'];",
        'const refs = ["--api-key", "process.env.API_KEY", "--signing-key", "$SIGNING_KEY"];',
        'command: ["tool", "--access-key", "access-secret"]',
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "tool --api-key [REDACTED] --token=[REDACTED] --password $PASSWORD --access-key process.env.ACCESS_KEY",
        "tool -password [REDACTED] -token ${TOKEN} -private-key $env:PRIVATE_KEY -consumer-key %CONSUMER_KEY%",
        "const args = ['--password', '[REDACTED]', '--token', '[REDACTED]'];",
        'const refs = ["--api-key", "process.env.API_KEY", "--signing-key", "$SIGNING_KEY"];',
        'command: ["tool", "--access-key", "[REDACTED]"]',
      ].join("\n"),
    );
    expect(result.redactionCount).toBe(6);
  });

  it("matches credential label components without corrupting lexical lookalikes or metadata", () => {
    const safe = [
      'author="Alice"',
      'const author = "Alice";',
      'authority="https://login.example.test"',
      'oauth="enabled"',
      'tokenizer="cl100k_base"',
      'tokenizationMode="fast"',
      'secretary="Alice"',
      'const secretariat = "office";',
      'authMode="oauth"',
      'authenticationStatus="ready"',
      'bearerType="JWT"',
      'credentialsPresent="yes"',
      'passwordPolicy="strict"',
      'apiKeyStatus="configured"',
    ];

    expect(redactSecretText(safe.join("\n"))).toEqual({ value: safe.join("\n"), redactionCount: 0 });
  });

  it("preserves cross-language credential declarations and code operators", () => {
    const safe = [
      "password: str",
      "var token: String? = null",
      'pub const API_KEY: &str = env!("API_KEY");',
      "function f(Authorization: string) {}",
      "const Authorization: string = authHeader;",
      "Authorization: SomeType<string>;",
      "const headers = { Authorization: `Bearer ${token}` };",
      "const f = password => password.length;",
      "items.map(token => token.id);",
      "if (password === expected) {}",
      "if (token == null) {}",
      "function f(password = defaultPassword) {}",
      "case password:\n  return true;",
      "const x = condition ? password : defaultPassword;",
      'const pythonHeaders = {"Authorization": f"Bearer {token}"}',
      'val authorization = "Bearer $token"',
      'headers := map[string]string{"Authorization": "Bearer " + token}',
      'let authorization = format!("Bearer {}", token);',
      "const credentials = [credentialRef, process.env.API_KEY];",
      "const config = { credentials: [credentialRef, process.env.API_KEY] };",
      "const secretRefs = { primary: vault.secretRef };",
    ];

    expect(redactSecretText(safe.join("\n"))).toEqual({ value: safe.join("\n"), redactionCount: 0 });
    expect(redactSecretText("const headers = { Authorization: Custom one two three }; ").value).toBe(
      "const headers = { Authorization: [REDACTED]}; ",
    );
  });

  it("redacts complete Cookie and Set-Cookie logical values in text and quoted code", () => {
    const result = redactSecretText(
      [
        "Cookie: safe=abc; session=hunter2; csrf=abcdef123456",
        "Cookie: a=one;\n b=two",
        "Set-Cookie: session=hunter2; Path=/; Secure; HttpOnly",
        'const header = "Cookie: a=one; session=hunter2; csrf=abcdef123456";',
      ].join("\nnext\n"),
    );

    expect(result.value).toBe(
      [
        "Cookie: [REDACTED]",
        "Cookie: [REDACTED]",
        "Set-Cookie: [REDACTED]",
        'const header = "Cookie: [REDACTED]";',
      ].join("\nnext\n"),
    );
  });

  it("redacts common fine-grained, package, model, and payment tokens without labels", () => {
    const secrets = [
      `github_pat_${"a".repeat(80)}`,
      `glpat-${"b".repeat(24)}`,
      `sk_live_${"c".repeat(24)}`,
      `rk_live_${"d".repeat(24)}`,
      `npm_${"e".repeat(36)}`,
      `hf_${"f".repeat(36)}`,
    ];
    const result = redactSecretText(secrets.join(" "));

    expect(result.value).toBe(secrets.map(() => "[REDACTED]").join(" "));
    expect(result.redactionCount).toBe(secrets.length);
  });

  it("redacts structured credential collections, YAML containers, tags, and anchors", () => {
    const result = redactSecretText(
      [
        'credentials: ["hunter2", "other"] okay',
        "credentials: {primary: hunter2, backup: other}",
        "credentials:\n  - hunter2\n  - other\nsafe: yes",
        "cookies:\n  - name: sid\n    value: hunter2\nsafe: yes",
        "password: !!str hunter2",
        "apiKey: &primary hunter2",
        "token: !vault hunter2",
      ].join("\nnext\n"),
    );

    expect(result.value).toBe(
      [
        "credentials: [REDACTED] okay",
        "credentials: [REDACTED]",
        "credentials: [REDACTED]\nsafe: yes",
        "cookies: [REDACTED]\nsafe: yes",
        "password: [REDACTED]",
        "apiKey: [REDACTED]",
        "token: [REDACTED]",
      ].join("\nnext\n"),
    );
    expect(result.value).not.toContain("hunter2");
  });

  it("redacts authorization flag schemes and their following credential", () => {
    const result = redactSecretText(
      [
        "curl --authorization Bearer hunter2 https://example.test",
        "curl -auth Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
        '["--authorization", "Bearer", "hunter2"]',
        "['--auth', 'Basic', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==']",
      ].join("\n"),
    );

    expect(result.value).toBe(
      [
        "curl --authorization [REDACTED] https://example.test",
        "curl -auth [REDACTED]",
        '["--authorization", "[REDACTED]", "[REDACTED]"]',
        "['--auth', '[REDACTED]', '[REDACTED]']",
      ].join("\n"),
    );
  });

  it("preserves safe credential metadata in scalar and CLI text", () => {
    const safe = [
      "credentialStorage: keychain",
      "credentialsFile: /home/user/.config/app",
      "secretFieldKeys: password,apiKey",
      `passwordHash: ${"a".repeat(64)}`,
      "signingKeyRef: vault:key",
      "tool --auth-method oauth2 --token-count 100 --api-key-env API_KEY --api-key-source env --authorization-header-name X-Auth",
      'authMethods: ["oauth2", "bearer"]',
    ];

    expect(redactSecretText(safe.join("\n"))).toEqual({ value: safe.join("\n"), redactionCount: 0 });
  });

  it("preserves cross-language secret references while redacting literals returned from ordinary calls", () => {
    const safe = [
      'let api_key = std::env::var("API_KEY")?;',
      'val apiKey = System.getenv("API_KEY")',
      'apiKey := os.Getenv("API_KEY")',
      "password := cfg.Password",
      "password := passwordValue",
      "apiKey := key",
      "token=$(pass show token)",
      'let secret = secret_store.get("name")?;',
    ];
    const input = [
      ...safe,
      'const password = getLiteral("hunter2");',
      'const token = Buffer.from("hunter2");',
      'let api_key = Some("hunter2".to_string());',
      'let authorization = format!("Bearer hunter2");',
      'password = f"hunter2"',
      'password = r"hunter2"',
    ].join("\n");
    const result = redactSecretText(input);

    expect(result.value).toBe(
      [
        ...safe,
        'const password = getLiteral("[REDACTED]");',
        'const token = Buffer.from("[REDACTED]");',
        'let api_key = Some("[REDACTED]".to_string());',
        'let authorization = format!("[REDACTED]");',
        'password = f"[REDACTED]"',
        'password = r"[REDACTED]"',
      ].join("\n"),
    );
  });

  it("recognizes JSON Unicode escapes in credential keys", () => {
    const result = redactSecretText(
      '{"pass\\u0077ord":"hunter2","api\\u004bey":"tiny-secret","\\u0063redentials":["other-secret"]}',
    );

    expect(result.value).toBe(
      '{"pass\\u0077ord":"[REDACTED]","api\\u004bey":"[REDACTED]","\\u0063redentials":[REDACTED]}',
    );
    expect(redactSecretText('{\\"pass\\u0077ord\\":\\"hunter2\\"}').value).toBe(
      '{\\"pass\\u0077ord\\":\\"[REDACTED]\\"}',
    );
  });

  it("keeps repeated assignment redaction bounded on single-line provider output", () => {
    const small = "password: safevalue ".repeat(2_500);
    const large = small.repeat(2);
    const startedSmall = performance.now();
    const smallResult = redactSecretText(small);
    const smallMs = Math.max(1, performance.now() - startedSmall);
    const startedLarge = performance.now();
    const largeResult = redactSecretText(large);
    const largeMs = performance.now() - startedLarge;

    expect(smallResult.redactionCount).toBe(2_500);
    expect(largeResult.redactionCount).toBe(5_000);
    expect(largeMs).toBeLessThan(2_000);
    expect(largeMs / smallMs).toBeLessThan(3.5);
  });

  it("redacts remote approval capability tokens inside callback data and free text", () => {
    const token = `grat_${"a".repeat(43)}`;
    const result = redactSecretText(`callback=gca:${token}:a raw=${token} prefixed=x${token} suffixed=${token}x`);

    expect(result.value).toBe("callback=gca:[REDACTED]:a raw=[REDACTED] prefixed=x[REDACTED] suffixed=[REDACTED]x");
    expect(result.redactionCount).toBe(4);
    expect(
      redactStructuredSecrets({
        callbackData: `gca:${token}:r`,
        note: `Use ${token} once`,
        tokenId: "remote-action-token-id",
      }).value,
    ).toEqual({
      callbackData: "gca:[REDACTED]:r",
      note: "Use [REDACTED] once",
      tokenId: "remote-action-token-id",
    });
  });

  it("does not redact benign token-like identifiers that are not canonical remote approval tokens", () => {
    const value = "Keep grat_community_discount_code and grat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF visible.";

    expect(redactSecretText(value)).toEqual({ value, redactionCount: 0 });
  });

  it("does not reinterpret repeated authorization labels as credential values", () => {
    const result = redactSecretText(`${"Authorization: ".repeat(128)}Bearer abcDEF-._~+/== done`);

    expect(result.value).toBe("Authorization: [REDACTED]");
    expect(result.value).not.toContain("abcDEF");
    expect(result.redactionCount).toBe(1);
  });

  it("preserves channel address schemes while still redacting URL userinfo", () => {
    const result = redactSecretText(
      "imessage:group@example.com whatsapp:15551234567@s.whatsapp.net https://user:pass@example.com/path",
    );

    expect(result.value).toBe(
      "imessage:group@example.com whatsapp:15551234567@s.whatsapp.net https://[REDACTED]@example.com/path",
    );
    expect(result.redactionCount).toBe(1);
  });

  it("redacts credential-bearing channel URL paths while preserving ordinary URLs", () => {
    const result = redactSecretText(
      [
        "failure https://hooks.slack.com/services/T000/B000/abc12345",
        "discord https://discord.com/api/webhooks/123456/discord-short",
        "telegram https://api.telegram.org/bot123456:telegram-short/sendMessage",
        "safe https://example.test/docs/token/setup",
      ].join("; "),
    );

    expect(result.value).toBe(
      [
        "failure https://hooks.slack.com/services/[REDACTED]/[REDACTED]/[REDACTED]",
        "discord https://discord.com/api/webhooks/[REDACTED]/[REDACTED]",
        "telegram https://api.telegram.org/bot[REDACTED]/sendMessage",
        "safe https://example.test/docs/token/setup",
      ].join("; "),
    );
    expect(result.redactionCount).toBe(3);
  });
});

describe("redactStructuredSecrets", () => {
  it("redacts sensitive keys and secret-bearing string leaves without mutating safe references or metrics", () => {
    const input = {
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    };

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    });
    expect(result.redactionCount).toBe(3);
    expect(result.redactedPaths).toEqual(["$.webhookUrl", "$.authorization", "$.DATABASE_PASSWORD"]);
    expect(result.redactions).toEqual([
      { path: "$.webhookUrl", reason: "sensitive_key" },
      { path: "$.authorization", reason: "sensitive_key" },
      { path: "$.DATABASE_PASSWORD", reason: "sensitive_key" },
    ]);
    expect(input).toEqual({
      webhookUrl: "https://example.test/hook?token=short-token",
      authorization: "Bearer short",
      DATABASE_PASSWORD: "tiny-secret",
      tokenEnv: "WEBHOOK_TOKEN",
      secretRef: "keychain:webhook-token",
      tokenBudget: 4_096,
      tokenId: "runtime-token-identifier-123456",
      refreshTokenHandle: "gmail-primary",
      tokenInput: 11,
      tokenOutput: 7,
      tokenCachedInput: 3,
      tokenTotal: 18,
      timeToFirstToken: 125,
      sessionTokenHardCap: 100_000,
      accessTokenExpiresAt: "2026-07-09T12:00:00.000Z",
      tokenRefreshSkewSeconds: 30,
    });
  });

  it("classifies generated-connector signing and consumer keys as credentials", () => {
    const input = {
      signingKey: "0123456789abcdef",
      consumerKey: "ck_0123456789abcdef",
      signingKeyId: "signing-key-1",
      consumerKeyRef: "keychain:consumer-key",
    };

    expect(redactStructuredSecrets(input).value).toEqual({
      signingKey: "[REDACTED]",
      consumerKey: "[REDACTED]",
      signingKeyId: "signing-key-1",
      consumerKeyRef: "keychain:consumer-key",
    });
    expect(input.signingKey).toBe("0123456789abcdef");
  });

  it("reports and safely projects circular references", () => {
    const input: Record<string, unknown> = { visible: "ok" };
    input.self = input;

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({ visible: "ok", self: "[Circular]" });
    expect(result.redactionCount).toBe(1);
    expect(result.redactedPaths).toEqual(["$.self"]);
    expect(result.redactions).toEqual([{ path: "$.self", reason: "circular_reference" }]);
    expect(input.self).toBe(input);
  });

  it("collapses a whole bearer credential leaf while preserving structure around embedded secrets", () => {
    expect(redactStructuredSecrets("Bearer abcdefghijklmnopqrstuvwxyz").value).toBe("[REDACTED]");
    expect(redactStructuredSecrets("result: Bearer abcdefghijklmnopqrstuvwxyz").value).toBe(
      "result: Bearer [REDACTED]",
    );
  });

  it("preserves explicitly typed binary payloads without exempting signatures or untyped high-entropy text", () => {
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    expect(
      redactStructuredSecrets({
        bytesBase64: pngBase64,
        dataBase64: pngBase64,
        b64Json: pngBase64,
        signatureBase64: pngBase64,
        opaque: pngBase64,
      }).value,
    ).toEqual({
      bytesBase64: pngBase64,
      dataBase64: pngBase64,
      b64Json: pngBase64,
      signatureBase64: "[REDACTED]",
      opaque: "[REDACTED]",
    });
  });

  it("contains short auth aliases without hiding non-secret auth metadata", () => {
    expect(
      redactStructuredSecrets({
        auth: "tiny",
        authContext: "operator",
        authenticationMode: "oauth",
      }).value,
    ).toEqual({
      auth: "[REDACTED]",
      authContext: "operator",
      authenticationMode: "oauth",
    });
  });

  it("preserves boolean credential-readiness metadata without trusting string lookalikes", () => {
    expect(
      redactStructuredSecrets({
        hasApiKey: true,
        hasKeychainSecret: false,
        requiresGatewayAuth: true,
        hasSecret: true,
        unsafe: { hasApiKey: "tiny-unlabelled-value" },
      }).value,
    ).toEqual({
      hasApiKey: true,
      hasKeychainSecret: false,
      requiresGatewayAuth: true,
      hasSecret: true,
      unsafe: { hasApiKey: "[REDACTED]" },
    });
  });

  it("does not let credential values bypass redaction through safe metadata keys", () => {
    expect(
      redactStructuredSecrets({
        tokenEnv: "Bearer short",
        secretRef: "https://example.test/hook?token=short-token",
        tokenId: "sk-1234567890abcdefghijklmnop",
        tokenBudget: "tiny-secret",
      }).value,
    ).toEqual({
      tokenEnv: "[REDACTED]",
      secretRef: "[REDACTED]",
      tokenId: "[REDACTED]",
      tokenBudget: "[REDACTED]",
    });
  });

  it("rejects credential syntax hidden in typed IDs, references, and cursors without mutating input", () => {
    const input = {
      secretRef: "password=hunter2",
      tokenId: "api_key=tiny-secret",
      sourceRef: "Authorization: Basic dXNlcjpwYXNz",
      cursor: "password=cursor-secret",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      artifactRef: "artifact-token-proof",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
    };
    const original = structuredClone(input);

    const result = redactStructuredSecrets(input);

    expect(result.value).toEqual({
      secretRef: "[REDACTED]",
      tokenId: "[REDACTED]",
      sourceRef: "Authorization: [REDACTED]",
      cursor: "password=[REDACTED]",
      safeSecretRef: "keychain:webhook-token",
      runId: "run-secret-projection",
      artifactRef: "artifact-token-proof",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
    });
    expect(result.redactionCount).toBe(4);
    expect(result.redactions).toEqual([
      { path: "$.secretRef", reason: "sensitive_key" },
      { path: "$.tokenId", reason: "sensitive_key" },
      { path: "$.sourceRef", reason: "secret_text" },
      { path: "$.cursor", reason: "secret_text" },
    ]);
    expect(input).toEqual(original);
  });

  it("contains path-carried webhook credentials while preserving credential-free OAuth metadata", () => {
    expect(
      redactStructuredSecrets({
        webhookUrl: "https://hooks.slack.com/services/T000/B000/shortsecret",
        authorizationUrl: "https://identity.example.test/oauth/authorize",
        tokenUrl: "https://identity.example.test/oauth/token",
        tokenEndpoint: "https://identity.example.test/oauth/token",
        authHeaderName: "X-Workspace-Authorization",
        authActorId: "operator-1",
        authActorSource: "loopback",
      }).value,
    ).toEqual({
      webhookUrl: "[REDACTED]",
      authorizationUrl: "https://identity.example.test/oauth/authorize",
      tokenUrl: "https://identity.example.test/oauth/token",
      tokenEndpoint: "https://identity.example.test/oauth/token",
      authHeaderName: "X-Workspace-Authorization",
      authActorId: "operator-1",
      authActorSource: "loopback",
    });
  });

  it("preserves typed identifiers and target keys even when their labels contain secret-shaped words", () => {
    expect(
      redactStructuredSecrets({
        runId: "run-secret-projection",
        approvalId: "approval-token-projection",
        artifactId: "artifact-secret-projection",
        operatorProfileId: "operator-secret-profile",
        targetKey: "target-secret-projection",
      }).value,
    ).toEqual({
      runId: "run-secret-projection",
      approvalId: "approval-token-projection",
      artifactId: "artifact-secret-projection",
      operatorProfileId: "operator-secret-profile",
      targetKey: "target-secret-projection",
    });
  });

  it("preserves shipped readiness, OAuth, and credential metadata without preserving nested credentials", () => {
    expect(
      redactStructuredSecrets({
        apiKeyReady: true,
        supportsRotateSecret: true,
        resolvesSecrets: true,
        persistSecretToSecureStore: false,
        apiKeySource: "keychain",
        authReadiness: "ready",
        authMethods: ["oauth", "bot_token"],
        authRequirements: ["device_identity", "short_lived_access_token"],
        authStatusCodes: [401, 403],
        authProfile: {
          accountRef: "meet-account-1",
          available: true,
          source: "oauth_thread",
        },
        authState: {
          authType: "oauth2",
          readiness: "ready",
          accessTokenRef: "keychain:mcp-access",
          refreshTokenRef: "keychain:mcp-refresh",
          tokenExpiresAt: "2026-07-09T12:00:00.000Z",
          scopes: ["repo:read"],
          error: "Authorization: Bearer nested-secret",
        },
        secretReadiness: {
          required: ["OPENAI_API_KEY"],
          configured: ["OPENAI_API_KEY"],
          missing: [],
        },
        secretFieldKeys: ["botToken", "clientSecret"],
        redactedSecretCount: 2,
        fencingToken: 7,
        credentialStorage: "partial",
        credentialFileChecks: [
          { pathLabel: "Codex auth file", exists: true, permissionStatus: "ok", note: "Metadata only" },
        ],
        peerCredentials: [
          {
            peerId: "peer-1",
            label: "Build peer",
            status: "configured",
            scopes: ["tasks:read"],
            checkedAt: "2026-07-09T12:00:00.000Z",
          },
        ],
        signatureAlgorithm: "ed25519",
        signatureStatus: "signed_hmac",
      }).value,
    ).toEqual({
      apiKeyReady: true,
      supportsRotateSecret: true,
      resolvesSecrets: true,
      persistSecretToSecureStore: false,
      apiKeySource: "keychain",
      authReadiness: "ready",
      authMethods: ["oauth", "bot_token"],
      authRequirements: ["device_identity", "short_lived_access_token"],
      authStatusCodes: [401, 403],
      authProfile: {
        accountRef: "meet-account-1",
        available: true,
        source: "oauth_thread",
      },
      authState: {
        authType: "oauth2",
        readiness: "ready",
        accessTokenRef: "keychain:mcp-access",
        refreshTokenRef: "keychain:mcp-refresh",
        tokenExpiresAt: "2026-07-09T12:00:00.000Z",
        scopes: ["repo:read"],
        error: "Authorization: [REDACTED]",
      },
      secretReadiness: {
        required: ["OPENAI_API_KEY"],
        configured: ["OPENAI_API_KEY"],
        missing: [],
      },
      secretFieldKeys: ["botToken", "clientSecret"],
      redactedSecretCount: 2,
      fencingToken: 7,
      credentialStorage: "partial",
      credentialFileChecks: [
        { pathLabel: "Codex auth file", exists: true, permissionStatus: "ok", note: "Metadata only" },
      ],
      peerCredentials: [
        {
          peerId: "peer-1",
          label: "Build peer",
          status: "configured",
          scopes: ["tasks:read"],
          checkedAt: "2026-07-09T12:00:00.000Z",
        },
      ],
      signatureAlgorithm: "ed25519",
      signatureStatus: "signed_hmac",
    });
  });

  it("preserves validated public auth containers and readiness records while projecting their leaves", () => {
    const runtimeAuth = {
      mode: "token",
      allowLoopbackBypass: false,
      tokenConfigured: true,
      basicConfigured: false,
      plan: {
        mode: "token",
        warnings: ["Authorization: Bearer nested-plan-secret"],
        token: { configured: true, source: "env" },
        basicUsername: { configured: false, source: "none" },
        basicPassword: { configured: false, source: "none" },
      },
    };

    expect(
      redactStructuredSecrets({
        runtime: { auth: runtimeAuth },
        connector: {
          auth: [{ id: "oauth", type: "oauth2", name: "OAuth", managed: true }],
        },
        followOn: {
          authReadiness: [
            {
              key: "short_lived_access_token",
              label: "Short-lived access token",
              state: "have_foundation",
              note: "Implemented",
            },
          ],
        },
        toolPolicy: {
          authContext: {
            boundary: "gateway_only",
            secretRefs: ["keychain:provider-token"],
          },
        },
        tokenEstimates: { system: 10, history: 20, total: 30 },
      }).value,
    ).toEqual({
      runtime: {
        auth: {
          ...runtimeAuth,
          plan: {
            ...runtimeAuth.plan,
            warnings: ["Authorization: [REDACTED]"],
          },
        },
      },
      connector: {
        auth: [{ id: "oauth", type: "oauth2", name: "OAuth", managed: true }],
      },
      followOn: {
        authReadiness: [
          {
            key: "short_lived_access_token",
            label: "Short-lived access token",
            state: "have_foundation",
            note: "Implemented",
          },
        ],
      },
      toolPolicy: {
        authContext: {
          boundary: "gateway_only",
          secretRefs: ["keychain:provider-token"],
        },
      },
      tokenEstimates: { system: 10, history: 20, total: 30 },
    });
  });

  it("preserves safe-shaped public previews, hashes, references, cursors, and blinded labels", () => {
    const tokenHash = "a".repeat(64);
    const requestSecretHash = "b".repeat(64);

    expect(
      redactStructuredSecrets({
        auth: { scheme: "bearer", tokenPreview: "noti...oken" },
        shortTokenPreview: "***",
        tokenHash,
        requestSecretHash,
        sourceRef: "memory://source-token-projection",
        artifactRefs: ["artifact-token-proof", "artifact-secret-proof"],
        cursor: "2026-07-09T12:00:00.000Z|session-token-projection",
        nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
        blindedAuthorToken: "proposal-1",
        blindedReviewerToken: "blind:anthropic:claude-sonnet-5",
      }).value,
    ).toEqual({
      auth: { scheme: "bearer", tokenPreview: "noti...oken" },
      shortTokenPreview: "***",
      tokenHash,
      requestSecretHash,
      sourceRef: "memory://source-token-projection",
      artifactRefs: ["artifact-token-proof", "artifact-secret-proof"],
      cursor: "2026-07-09T12:00:00.000Z|session-token-projection",
      nextCursor: "eyJwYWdlIjoyLCJ0b2tlbiI6InByb2plY3Rpb24ifQ==",
      blindedAuthorToken: "proposal-1",
      blindedReviewerToken: "blind:anthropic:claude-sonnet-5",
    });
  });

  it("keeps browser cookie summaries while containing raw plural cookie values", () => {
    expect(
      redactStructuredSecrets({
        summary: { cookies: { count: 2, domains: ["example.test", "docs.example.test"] } },
        rawArray: { cookies: [{ name: "session", value: "tiny" }] },
        rawObject: { cookies: { session: "tiny" } },
        rawString: { cookies: "tiny" },
      }).value,
    ).toEqual({
      summary: { cookies: { count: 2, domains: ["example.test", "docs.example.test"] } },
      rawArray: { cookies: "[REDACTED]" },
      rawObject: { cookies: "[REDACTED]" },
      rawString: { cookies: "[REDACTED]" },
    });
  });

  it("fails closed for metadata lookalikes, malformed safe-key values, and actual credential fields", () => {
    const approvalCapabilityToken = `grat_${"a".repeat(43)}`;
    const telegramBotToken = `1234567890:${"b".repeat(35)}`;
    const result = redactStructuredSecrets({
      apiKeyReady: "true",
      apiKeySource: "inline-but-secret",
      authReadiness: "Bearer raw-readiness",
      auth: { type: "query", value: "tiny" },
      tokenPreview: "raw-token-value",
      tokenHash: "not-a-cryptographic-digest",
      requestSecretHash: "tiny",
      fencingToken: "7",
      blindedAuthorToken: "raw-token-value",
      blindedReviewerToken: "Bearer raw-reviewer",
      cursor: "https://example.test/page?token=raw-cursor",
      sourceRef: "https://example.test/page?access_token=raw-source",
      runId: approvalCapabilityToken,
      artifactRef: telegramBotToken,
      nextCursor: approvalCapabilityToken,
      tokenEnv: { value: "tiny" },
      secretRef: { value: "tiny" },
      unsafeSecretRef: "tiny secret",
      refreshTokenHandle: "tiny handle",
      tokenId: ["tiny"],
      peerCredentials: [{ peerId: "peer-1", token: "tiny" }],
      apiKey: "tiny",
      accessToken: "tiny",
      refreshToken: "tiny",
      token: "tiny",
      clientSecret: "tiny",
      password: "tiny",
      signature: "tiny",
      signatureBase64: "tiny",
      deviceToken: "tiny",
      botToken: "tiny",
    }).value;

    expect(result).toEqual({
      apiKeyReady: "[REDACTED]",
      apiKeySource: "[REDACTED]",
      authReadiness: "[REDACTED]",
      auth: "[REDACTED]",
      tokenPreview: "[REDACTED]",
      tokenHash: "[REDACTED]",
      requestSecretHash: "[REDACTED]",
      fencingToken: "[REDACTED]",
      blindedAuthorToken: "[REDACTED]",
      blindedReviewerToken: "[REDACTED]",
      cursor: "https://example.test/page?token=[REDACTED]",
      sourceRef: "https://example.test/page?access_token=[REDACTED]",
      runId: "[REDACTED]",
      artifactRef: "[REDACTED]",
      nextCursor: "[REDACTED]",
      tokenEnv: "[REDACTED]",
      secretRef: "[REDACTED]",
      unsafeSecretRef: "[REDACTED]",
      refreshTokenHandle: "[REDACTED]",
      tokenId: "[REDACTED]",
      peerCredentials: "[REDACTED]",
      apiKey: "[REDACTED]",
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      token: "[REDACTED]",
      clientSecret: "[REDACTED]",
      password: "[REDACTED]",
      signature: "[REDACTED]",
      signatureBase64: "[REDACTED]",
      deviceToken: "[REDACTED]",
      botToken: "[REDACTED]",
    });
  });
});
