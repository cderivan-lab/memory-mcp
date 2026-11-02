"use strict";

// UI end-to-end: drives the running VS Code window, clicks "Download now" on
// the embedding-model offer, and asserts the flow reaches a terminal state.
// This is the one path the in-host suite cannot cover: VS Code exposes no API
// for pressing a notification button, so only a UI driver can do it.
//
// The stub binary seeded by scripts/e2e-ui-fixtures.mjs makes activation
// resolve a binary, so the first install offer is the model rather than the
// binary itself. The DOM is used directly instead of ExTester's page objects,
// which resolve to stale elements on VS Code 1.144 and throw before returning
// any notification.
//
// The download goes to the project's model archive. When that is unreachable
// (404, no token, offline) the extension reports the failure; the test accepts
// a reported failure or a completed install, because both prove the click
// reached the download path instead of being a no-op.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { By } = require("selenium-webdriver");
const { VSBrowser } = require("vscode-extension-tester");

// The layout the server resolves on disk; one source of truth.
const {
  dir: MODEL_DIR_NAME,
  files: MODEL_FILES,
} = require("../../src/model-manifest.json");

const OFFER_TIMEOUT = 60_000;
const TERMINAL_TIMEOUT = 180_000;
const POLL_INTERVAL = 500;

/** The model notification's message, as provisionModel composes it. */
const OFFER = new RegExp(`The ${MODEL_DIR_NAME} embedding model`);

/** A finished flow: either the model install or its reported failure. */
const TERMINAL = /Could not download|pali installed at/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A successful model install sends no notification (the progress toast simply
 * disappears), so success is observed where it lands: the extension's
 * globalStorage inside the test instance's user-data directory.
 */
function modelFilesInstalled() {
  const storage = path.resolve(
    process.env.PALI_E2E_STORAGE ?? path.join(__dirname, "..", "..", "test-resources"),
  );
  const dir = path.join(
    storage,
    "settings",
    "User",
    "globalStorage",
    "cderivan.pali-memory",
    "models",
    MODEL_DIR_NAME,
  );
  return Object.values(MODEL_FILES).every((name) => {
    try {
      return fs.statSync(path.join(dir, name)).size > 0;
    } catch {
      return false;
    }
  });
}

async function bodyText(driver) {
  return String(await driver.executeScript("return document.body.innerText"));
}

/**
 * Find the "Download now" action belonging to the model offer. VS Code renders
 * notification actions as role=button or monaco-button elements depending on
 * version, so the scoped selectors are tried before a text-checked fallback.
 */
async function findModelDownloadButton(driver) {
  const scoped = [
    "//*[contains(@class,'notification-toast')][contains(.,'embedding model')]" +
      "//*[normalize-space(.)='Download now']",
    "//*[contains(@class,'notification-list-item')][contains(.,'embedding model')]" +
      "//*[normalize-space(.)='Download now']",
  ];
  for (const selector of scoped) {
    for (const element of await driver.findElements(By.xpath(selector))) {
      if (await element.isDisplayed().catch(() => false)) return element;
    }
  }

  // Fallback: any visible action, but only while the model offer is on screen,
  // so the click cannot land on a different notification's button.
  if (!OFFER.test(await bodyText(driver))) return null;
  const any = "//*[@role='button' and normalize-space(.)='Download now']";
  for (const element of await driver.findElements(By.xpath(any))) {
    if (await element.isDisplayed().catch(() => false)) return element;
  }
  return null;
}

describe("model install flow from the notification", () => {
  it("clicks Download now on the model offer and reaches a terminal state", async function () {
    this.timeout(OFFER_TIMEOUT + TERMINAL_TIMEOUT + 60_000);
    const driver = VSBrowser.instance.driver;

    let button = null;
    const offerDeadline = Date.now() + OFFER_TIMEOUT;
    while (!button && Date.now() < offerDeadline) {
      button = await findModelDownloadButton(driver);
      if (!button) await sleep(POLL_INTERVAL);
    }

    const offerText = await bodyText(driver);
    assert.ok(
      button,
      `activation must offer the ${MODEL_DIR_NAME} model for download; ` +
        `workbench text: ${offerText.slice(0, 600)}`,
    );
    assert.match(offerText, OFFER, "the offer must name the embedding model");
    // The seeded pali.path must have been picked up: otherwise activation asks
    // about the binary and this suite would silently test the wrong offer.
    assert.doesNotMatch(
      offerText,
      /binary was not found/,
      "the seeded pali.path must suppress the binary offer",
    );

    // A result already on screen would let the test pass without the click.
    assert.doesNotMatch(
      offerText,
      TERMINAL,
      "no install result may be on screen before the click",
    );

    await button.click();

    const deadline = Date.now() + TERMINAL_TIMEOUT;
    while (Date.now() < deadline) {
      if (modelFilesInstalled()) {
        console.log(`model install flow ended with: ${MODEL_DIR_NAME} installed`);
        return;
      }
      const match = TERMINAL.exec(await bodyText(driver));
      if (match) {
        console.log(`model install flow ended with: ${match[0]}`);
        return;
      }
      await sleep(POLL_INTERVAL);
    }

    assert.fail(
      "clicking Download now never reached a terminal state; " +
        `workbench text: ${(await bodyText(driver)).slice(0, 800)}`,
    );
  });
});
