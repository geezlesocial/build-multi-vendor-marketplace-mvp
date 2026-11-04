import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalEnvFile,
  renderLocalEnv,
  validateLocalEnvTemplate,
} from "./dev-bootstrap.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const template = readFileSync(
  path.join(repositoryRoot, ".env.example"),
  "utf8",
);
const tempDirectories = new Set();

function makeTempDirectory() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "marketplace-bootstrap-"),
  );
  tempDirectories.add(directory);
  return directory;
}

test.after(() => {
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generates fresh unique cryptographic local secrets and keeps gates closed", () => {
  const generated = renderLocalEnv(template);
  const originalValues = new Map(
    template
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value]),
  );
  const generatedValues = new Map(
    generated
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value]),
  );
  const secretNames = [
    "PASSWORD_PEPPER",
    "SOCIAL_LOGIN_ENCRYPTION_KEY",
    "PAYOUT_ENCRYPTION_KEY",
    "DROPSHIPPING_ENCRYPTION_KEY",
    "AFFILIATE_SIGNING_SECRET",
  ];
  const secrets = secretNames.map((name) => generatedValues.get(name));

  assert.equal(new Set(secrets).size, secretNames.length);
  for (const secret of secrets) assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  for (const name of secretNames) {
    assert.notEqual(generatedValues.get(name), originalValues.get(name));
  }
  assert.deepEqual(validateLocalEnvTemplate(generated), generatedValues);
});

test("refuses a template that enables an integration or financial gate", () => {
  const unsafe = template.replace(
    "LIVE_SHOPPING_AVAILABLE=false",
    "LIVE_SHOPPING_AVAILABLE=true",
  );
  assert.throws(() => renderLocalEnv(unsafe), /LIVE_SHOPPING_AVAILABLE/);
});

test("refuses repeated secret material from a faulty secret generator", () => {
  assert.throws(
    () => renderLocalEnv(template, { generateSecret: () => "A".repeat(43) }),
    /secrets must be unique/,
  );
});

test("creates .env once and leaves an existing file byte-for-byte unchanged", () => {
  const directory = makeTempDirectory();
  const examplePath = path.join(directory, ".env.example");
  const envPath = path.join(directory, ".env");
  writeFileSync(examplePath, template);

  assert.deepEqual(createLocalEnvFile({ examplePath, envPath }), {
    status: "created",
  });
  const firstContents = readFileSync(envPath, "utf8");
  writeFileSync(envPath, `${firstContents}\nOWNER_LOCAL_MARKER=preserve-me\n`);
  const beforeSecondRun = readFileSync(envPath, "utf8");

  assert.deepEqual(createLocalEnvFile({ examplePath, envPath }), {
    status: "exists",
  });
  assert.equal(readFileSync(envPath, "utf8"), beforeSecondRun);
});

test("removes only its own partial .env when writing fails", () => {
  const directory = makeTempDirectory();
  const examplePath = path.join(directory, ".env.example");
  const envPath = path.join(directory, ".env");
  writeFileSync(examplePath, template);
  const realFileSystem = {
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    fsyncSync,
  };
  const failingFileSystem = {
    ...realFileSystem,
    writeFileSync(descriptor) {
      writeFileSync(descriptor, "PARTIAL_SECRET=not-complete\n", "utf8");
      throw new Error("injected write failure");
    },
  };

  assert.throws(
    () =>
      createLocalEnvFile({
        examplePath,
        envPath,
        fileSystem: failingFileSystem,
      }),
    /partial file created by this command was removed/,
  );
  assert.equal(existsSync(envPath), false);
});

test("does not remove or replace a pre-existing file after a creation failure", () => {
  const directory = makeTempDirectory();
  const examplePath = path.join(directory, ".env.example");
  const envPath = path.join(directory, ".env");
  writeFileSync(examplePath, template);
  writeFileSync(envPath, "OWNER_SECRET=leave-this-alone\n");
  const before = readFileSync(envPath, "utf8");

  assert.deepEqual(createLocalEnvFile({ examplePath, envPath }), {
    status: "exists",
  });
  assert.equal(readFileSync(envPath, "utf8"), before);
});

test("refuses an existing non-file .env path without modifying it", () => {
  const directory = makeTempDirectory();
  const examplePath = path.join(directory, ".env.example");
  const envPath = path.join(directory, ".env");
  writeFileSync(examplePath, template);
  const existingDirectory = path.join(envPath, "preserve-me");
  mkdirSync(envPath);
  writeFileSync(existingDirectory, "keep this path\n");

  assert.throws(
    () => createLocalEnvFile({ examplePath, envPath }),
    /non-file path already exists/,
  );
  assert.equal(readFileSync(existingDirectory, "utf8"), "keep this path\n");
});
