import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("infra/nginx/reconai.conf"), "utf8");
const required = [
  {
    pattern: /log_format reconai_access escape=json/u,
    message: "edge access log is not emitted as bounded JSON",
  },
  {
    pattern: /"method":"\$request_method","path":"\$uri"/u,
    message: "edge access log does not use the query-free normalized request path",
  },
  {
    pattern: /access_log \/var\/log\/nginx\/access\.log reconai_access;/u,
    message: "edge access log does not use the reviewed redacted format",
  },
  {
    pattern: /limit_req_zone \$binary_remote_addr zone=reconai_api_per_ip:10m rate=20r\/s;/u,
    message: "missing bounded per-network API rate zone",
  },
  {
    pattern: /upstream reconai_web \{[^}]*server web:3000;[^}]*keepalive 16;/u,
    message: "browser upstream is not explicit and keepalive-bounded",
  },
  {
    pattern: /upstream reconai_api \{[^}]*server api:4000;[^}]*keepalive 32;/u,
    message: "Fastify upstream is not explicit and keepalive-bounded",
  },
  {
    pattern: /server_tokens off;/u,
    message: "edge response fingerprinting is not disabled",
  },
  {
    pattern: /location \/api\/ \{[^}]*limit_req zone=reconai_api_per_ip burst=40 nodelay;/u,
    message: "browser API location does not enforce the outer rate zone",
  },
  {
    pattern: /location \/api\/ \{[^}]*limit_req_status 429;/u,
    message: "browser API location does not return an explicit rate-limit status",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_pass http:\/\/reconai_web;/u,
    message: "browser API routes do not preserve the Next.js BFF/auth boundary",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_http_version 1\.1;/u,
    message: "browser API upstream keepalive protocol is not explicit",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_set_header X-Forwarded-For \$remote_addr;/u,
    message: "browser proxy does not overwrite client-selected forwarding authority",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_set_header X-Real-IP \$remote_addr;/u,
    message: "browser proxy does not overwrite client-selected real-address metadata",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_set_header X-Forwarded-Host \$host;/u,
    message: "browser proxy does not overwrite client-selected forwarded host authority",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_set_header X-Forwarded-Proto \$scheme;/u,
    message: "browser proxy does not overwrite client-selected forwarded protocol authority",
  },
  {
    pattern: /location \/api\/ \{[^}]*proxy_set_header Forwarded "";/u,
    message: "browser proxy does not remove the client-selected standardized forwarding header",
  },
  {
    pattern: /location \/v1\/ \{[^}]*limit_req zone=reconai_api_per_ip burst=40 nodelay;/u,
    message: "Fastify API location does not enforce the outer rate zone",
  },
  {
    pattern: /location \/v1\/ \{[^}]*limit_req_status 429;/u,
    message: "Fastify API location does not return an explicit rate-limit status",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_pass http:\/\/reconai_api;/u,
    message: "versioned Fastify API routes do not preserve their path",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_http_version 1\.1;/u,
    message: "Fastify API upstream keepalive protocol is not explicit",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_set_header X-Real-IP \$remote_addr;/u,
    message: "Fastify proxy does not derive the client address from the connected peer",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_set_header X-Forwarded-For \$remote_addr;/u,
    message: "Fastify proxy does not overwrite client-selected forwarding authority",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_set_header X-Forwarded-Host \$host;/u,
    message: "Fastify proxy does not overwrite client-selected forwarded host authority",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_set_header X-Forwarded-Proto \$scheme;/u,
    message: "Fastify proxy does not overwrite client-selected forwarded protocol authority",
  },
  {
    pattern: /location \/v1\/ \{[^}]*proxy_set_header Forwarded "";/u,
    message: "Fastify proxy does not remove the client-selected standardized forwarding header",
  },
  {
    pattern: /location \/ \{[^}]*proxy_pass http:\/\/reconai_web;/u,
    message: "catch-all browser routes do not use the explicit web upstream",
  },
  {
    pattern: /location \/ \{[^}]*proxy_set_header X-Real-IP \$remote_addr;/u,
    message: "catch-all browser proxy does not overwrite client-selected real-address metadata",
  },
  {
    pattern: /location \/ \{[^}]*proxy_set_header X-Forwarded-For \$remote_addr;/u,
    message: "catch-all browser proxy does not overwrite client-selected forwarding authority",
  },
  {
    pattern: /location \/ \{[^}]*proxy_set_header X-Forwarded-Host \$host;/u,
    message: "catch-all browser proxy does not overwrite client-selected forwarded host authority",
  },
  {
    pattern: /location \/ \{[^}]*proxy_set_header X-Forwarded-Proto \$scheme;/u,
    message:
      "catch-all browser proxy does not overwrite client-selected forwarded protocol authority",
  },
  {
    pattern: /location \/ \{[^}]*proxy_set_header Forwarded "";/u,
    message: "catch-all browser proxy does not remove client-selected standardized forwarding data",
  },
  {
    pattern: /client_max_body_size 12m;/u,
    message: "edge request-body ceiling is missing",
  },
  {
    pattern: /client_body_timeout 15s;/u,
    message: "edge slow-body timeout is missing",
  },
];

const forbiddenForwardingMessage =
  "edge proxy preserves untrusted client-supplied forwarding metadata";
const forbiddenAccessLogMessage =
  "edge access logs may include query, referrer, cookie, or authorization data";
const failures = validateConfiguration(source);
const negativeFixtures = [
  {
    name: "query-bearing request URI in access log",
    configuration: source.replace('"path":"$uri"', '"path":"$request_uri"'),
    expectedMessage: forbiddenAccessLogMessage,
  },
  {
    name: "default combined access log",
    configuration: source.replace(
      "access_log /var/log/nginx/access.log reconai_access;",
      [
        "access_log /var/log/nginx/access.log reconai_access;",
        "access_log /var/log/nginx/query-bearing.log combined;",
      ].join("\n"),
    ),
    expectedMessage: forbiddenAccessLogMessage,
  },
  {
    name: "appended X-Forwarded-For chain",
    configuration: source.replace(
      "proxy_set_header X-Forwarded-For $remote_addr;",
      [
        "proxy_set_header X-Forwarded-For $remote_addr;",
        "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      ].join("\n"),
    ),
    expectedMessage: forbiddenForwardingMessage,
  },
  {
    name: "copied standardized Forwarded header",
    configuration: source.replace(
      'proxy_set_header Forwarded "";',
      ['proxy_set_header Forwarded "";', "    proxy_set_header Forwarded $http_forwarded;"].join(
        "\n",
      ),
    ),
    expectedMessage: forbiddenForwardingMessage,
  },
];
for (const fixture of negativeFixtures) {
  if (!validateConfiguration(fixture.configuration).includes(fixture.expectedMessage)) {
    failures.push(`validator self-test accepted ${fixture.name}`);
  }
}
if (failures.length > 0) {
  process.stderr.write(`Edge security validation failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Validated reference edge log-redaction, request, and forwarding controls.\n");

function validateConfiguration(configuration) {
  const validationFailures = required
    .filter(({ pattern }) => !pattern.test(configuration))
    .map(({ message }) => message);
  if (
    /\$(?:http_(?:forwarded|x_forwarded_(?:for|host|proto))|proxy_add_x_forwarded_for)\b/u.test(
      configuration,
    )
  ) {
    validationFailures.push(forbiddenForwardingMessage);
  }
  if (/proxy_set_header Forwarded (?!"";)[^;]+;/u.test(configuration)) {
    validationFailures.push("edge proxy forwards client-selected standardized forwarding metadata");
  }
  if (
    /\$(?:request|request_uri|args|query_string|http_referer|http_cookie|http_authorization|http_user_agent)\b/u.test(
      configuration,
    ) ||
    /access_log [^;]*\bcombined;/u.test(configuration)
  ) {
    validationFailures.push(forbiddenAccessLogMessage);
  }
  return validationFailures;
}
