import test from "node:test";
import assert from "node:assert/strict";
import { smartFetch } from "../extensions/oh-my-opencode-pi/smartfetch.ts";

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("smartFetch prefers llms.txt for docs-like URLs when available", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://docs.example.com/llms-full.txt") {
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    }
    if (url === "https://docs.example.com/llms.txt") {
      return new Response("# Example Docs\n\nUse the API carefully.", { status: 200, headers: { "content-type": "text/markdown" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await smartFetch("https://docs.example.com/reference", {
    timeoutMs: 1000,
    userAgent: "test-agent",
  });

  assert.equal(result.details.usedLlmsTxt, true);
  assert.equal(result.details.source, "llms-txt");
  assert.match(result.text, /Source: llms\.txt/);
  assert.match(result.text, /# Example Docs/);
  assert.deepEqual(calls, [
    "https://docs.example.com/llms-full.txt",
    "https://docs.example.com/llms.txt",
  ]);
});

test("smartFetch falls back to extracted HTML content when llms.txt is unavailable", async () => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://docs.example.com/llms-full.txt" || url === "https://docs.example.com/llms.txt") {
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    }
    if (url === "https://docs.example.com/guide/getting-started") {
      return new Response(`
        <html>
          <head><title>Getting Started</title></head>
          <body>
            <nav>Menu</nav>
            <main>
              <h1>Getting Started</h1>
              <p>Install the package and run the setup command.</p>
              <p>This paragraph should survive extraction.</p>
            </main>
            <footer>Footer</footer>
          </body>
        </html>
      `, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await smartFetch("https://docs.example.com/guide/getting-started", {
    timeoutMs: 1000,
    userAgent: "test-agent",
  });

  assert.equal(result.details.usedLlmsTxt, false);
  assert.equal(result.details.source, "html");
  assert.match(result.text, /Title: Getting Started/);
  assert.match(result.text, /Install the package and run the setup command/);
  assert.doesNotMatch(result.text, /Menu/);
});

test("smartFetch follows same-origin redirects", async () => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://example.com/start") {
      return new Response("", {
        status: 302,
        headers: { location: "/final" },
      });
    }
    if (url === "https://example.com/final") {
      return new Response("final body", { status: 200, headers: { "content-type": "text/plain" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await smartFetch("https://example.com/start", {
    timeoutMs: 1000,
    userAgent: "test-agent",
    preferLlmsTxt: "never",
  });

  assert.equal(result.details.finalUrl, "https://example.com/final");
  assert.equal(result.details.redirects.length, 1);
  assert.match(result.text, /Redirects: https:\/\/example\.com\/final/);
});

test("smartFetch blocks cross-origin redirects by default", async () => {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url === "https://example.com/start") {
      return new Response("", {
        status: 302,
        headers: { location: "https://evil.example.net/final" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  await assert.rejects(
    smartFetch("https://example.com/start", {
      timeoutMs: 1000,
      userAgent: "test-agent",
      preferLlmsTxt: "never",
    }),
    /Cross-origin redirect blocked/,
  );
});
