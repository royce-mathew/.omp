import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  canonicalizePath,
  decideReadPolicy,
  decideWritePolicy,
  domainIsAllowed,
  extractNetworkTargetsFromCommand,
  formatNetworkTarget,
  isHostFilesystemTool,
  matchesPath,
  readPathForToolCall,
  writePathsForToolCall,
} from "../policy.ts";

describe("sandbox policy", () => {
  test("extracts and deduplicates literal HTTP domains", () => {
    const targets = extractNetworkTargetsFromCommand(
      "curl https://API.example.com/a http://api.example.com:8080/b",
    );
    expect(targets).toEqual([
      { host: "api.example.com", port: 443 },
      { host: "api.example.com", port: 8080 },
    ]);
    expect(formatNetworkTarget(targets[0]!)).toBe("api.example.com:443");
    expect(formatNetworkTarget({ host: "::1", port: 8080 })).toBe("[::1]:8080");
  });

  test("matches exact, strict wildcard, and port-scoped domain rules", () => {
    expect(domainIsAllowed("github.com", ["github.com"], 443)).toBe(true);
    expect(domainIsAllowed("api.github.com", ["*.github.com"], 443)).toBe(true);
    expect(domainIsAllowed("github.com", ["*.github.com"], 443)).toBe(false);
    expect(domainIsAllowed("api.github.com", ["api.github.com:443"], 443)).toBe(true);
    expect(domainIsAllowed("api.github.com", ["api.github.com:443"], 80)).toBe(false);
  });

  test("resolves OMP filesystem targets and ignores remote reads", () => {
    const cwd = "/workspace";
    expect(readPathForToolCall("read", { path: "secret.txt:1-5" }, cwd))
      .toBe("/workspace/secret.txt");
    expect(readPathForToolCall("grep", { pattern: "token", path: "/private" }, cwd)).toBe("/private");
    expect(readPathForToolCall("glob", { path: "." }, cwd)).toBe(cwd);
    expect(readPathForToolCall("read", { path: "https://example.test/file" }, cwd)).toBeUndefined();
    expect(readPathForToolCall("bash", { command: "cat /private/file" }, cwd)).toBeUndefined();
  });

  test("identifies OMP tools that bypass sandboxed execution", () => {
    expect(["grep", "glob", "lsp", "python", "notebook", "inspect_image"]
      .every(isHostFilesystemTool)).toBe(true);
    expect(isHostFilesystemTool("read")).toBe(false);
  });

  test("uses OMP's canonical edit model for every write destination", () => {
    const cwd = "/workspace";
    expect(writePathsForToolCall("write", { path: "result.txt" }, cwd))
      .toEqual(["/workspace/result.txt"]);
    expect(writePathsForToolCall("edit", {
      paths: ["untrusted.ts"],
      input: "[one.ts#A1B2]\nMV /outside/moved.ts\n[two.ts#C3D4]\nREM\n",
    }, cwd)).toEqual([
      "/workspace/one.ts",
      "/outside/moved.ts",
      "/workspace/two.ts",
    ]);
    expect(writePathsForToolCall("edit", { path: "source.ts" }, cwd))
      .toEqual(["/workspace/source.ts"]);
    expect(() => writePathsForToolCall("edit", {
      paths: ["untrusted.ts"],
      input: "unparsed",
    }, cwd)).toThrow();
    expect(writePathsForToolCall("edit", { paths: ["untrusted.ts"] }, cwd)).toBeUndefined();
  });

  test("preserves specific read denies inside broad allows", () => {
    expect(decideReadPolicy("/workspace/.env", ["/workspace"], ["/workspace/.env"]))
      .toBe("prompt");
    expect(decideReadPolicy("/workspace/src/a.ts", ["/workspace"], ["/home"]))
      .toBe("allow");
    expect(decideReadPolicy("/workspace/.env", ["/workspace/.env"], ["/workspace/.env"]))
      .toBe("allow");
  });

  test("gives write denies precedence over allows", () => {
    expect(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"])).toBe("deny");
    expect(decideWritePolicy("/tmp/file", ["/tmp"], [])).toBe("allow");
    expect(decideWritePolicy("/tmp/file", [], [])).toBe("prompt");
  });

  test("matches directory prefixes and path globs relative to the provided cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-policy-"));
    expect(matchesPath(join(root, "nested/file.ts"), ["."], root)).toBe(true);
    expect(matchesPath(join(root, "secret.pem"), ["*.pem"], root)).toBe(true);
    expect(matchesPath(join(root, "nested/secret.pem"), ["*.pem"], root)).toBe(false);
    expect(matchesPath(join(root, "nested/secret.pem"), ["**/*.pem"], root)).toBe(true);
    expect(matchesPath("/home/user/file", ["/"], "/")).toBe(true);
    expect(matchesPath("/home-user/file", ["/home"], "/")).toBe(false);
  });

  test("canonicalizes symlinks and nonexistent descendants", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-canonical-"));
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(canonicalizePath(join(link, "new/file"))).toBe(join(real, "new/file"));
  });
});
