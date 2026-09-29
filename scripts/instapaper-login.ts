#!/usr/bin/env bun
// Trades an Instapaper login for the access token and secret the Worker signs
// with, through xAuth. The password goes to Instapaper once, from memory, and
// Instapaper's terms forbid keeping it, so nothing here writes it anywhere.
// The token stays valid until the password changes or access is revoked.

import { once } from "node:events";
import { z } from "zod";
import {
  InstapaperResponseError,
  instapaperPost,
  instapaperPostText,
} from "../src/instapaper/client";
import { verifyCredentialsResponse } from "../src/instapaper/schema";

const ACCESS_TOKEN = z.object({
  oauth_token: z.string().min(1),
  oauth_token_secret: z.string().min(1),
});

const ETX = "\u0003";
const DELETE = new Set(["\u007f", "\b"]);

const consumerKey = required("INSTAPAPER_CONSUMER_KEY");
const consumerSecret = required("INSTAPAPER_CONSUMER_SECRET");

if (!process.stdin.isTTY) {
  fail("run this in a terminal, which it needs to read the password without echo");
}

const username = await prompt("Instapaper email or username: ", true);
// Instapaper accounts may have no password, which xAuth takes as empty.
const password = await prompt("Password, blank if none: ", false);

try {
  const answer = await instapaperPostText(
    { consumerKey, consumerSecret },
    "/api/1/oauth/access_token",
    {
      x_auth_username: username,
      x_auth_password: password,
      x_auth_mode: "client_auth",
    },
  );
  const parsed = ACCESS_TOKEN.safeParse(Object.fromEntries(new URLSearchParams(answer)));
  if (!parsed.success) {
    fail("Instapaper answered without an access token");
  }
  const token = parsed.data.oauth_token;
  const tokenSecret = parsed.data.oauth_token_secret;

  const { data } = await instapaperPost(
    { consumerKey, consumerSecret, token, tokenSecret },
    "/api/1/account/verify_credentials",
    {},
    verifyCredentialsResponse,
  );
  const [user] = data;
  if (user !== undefined) {
    const subscription = user.subscription_is_active ? "active" : "inactive";
    console.error(`Signed in as ${user.username} (${user.user_id}), subscription ${subscription}.`);
  }

  console.error("Add these to the logbook Environment in 1Password:");
  console.log(`INSTAPAPER_ACCESS_TOKEN=${token}`);
  console.log(`INSTAPAPER_ACCESS_SECRET=${tokenSecret}`);
} catch (error) {
  // The body is Instapaper's answer, which never echoes the password back.
  if (error instanceof InstapaperResponseError) {
    fail(`Instapaper answered ${error.status}: ${error.message}`);
  }
  throw error;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    fail(
      `${name} is not set. Run this through \`bun run instapaper:login\`, which loads .dev.vars.`,
    );
  }
  return value;
}

// Raw mode hands over each keystroke, so a hidden answer is never on screen.
async function prompt(question: string, echo: boolean): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let line = "";
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const [chunk]: unknown[] = await once(stdin, "data");
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") {
          return line;
        }
        if (char === ETX) {
          stdin.setRawMode(false);
          stderr.write("\n");
          process.exit(130);
        }
        if (DELETE.has(char)) {
          if (line.length > 0) {
            line = line.slice(0, -1);
            if (echo) {
              stderr.write("\b \b");
            }
          }
        } else {
          line += char;
          if (echo) {
            stderr.write(char);
          }
        }
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write("\n");
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
