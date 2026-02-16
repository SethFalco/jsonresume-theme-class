/**
 * @fileoverview
 *   This is a test to see if there would be a practical way to configure Pa11y
 *   to automatically retest the same webpage but with different color
 *   deficiencies.
 *
 *   This is nothing but a quick and dirty proof-of-concept showing a couple of
 *   things one could explore. But it might be useless. ^-^'
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { styleText } from 'node:util';
import { simulate } from '@bjornlu/colorblind';
import { protanopia, deuteranopia, tritanopia, achromatopsia } from '@cantoo/color-blindness';
import convert from 'color-convert';
import * as csstree from 'css-tree';
import pa11y from 'pa11y';
import puppeteer from 'puppeteer';

/**
 * @typedef {'light'|'dark'} ColorScheme
 *
 * @typedef {object} TestCase
 * @property {string} name
 * @property {ColorScheme} colorScheme
 * @property {import('@bjornlu/colorblind').Deficiency=} visionDeficiency
 */

const FILE_PATH = path.join(import.meta.dirname, 'resume.html');

/** @type {TestCase[]} */
const TEST_CASES = [
  {
    name: 'Light Mode',
    colorScheme: 'light',
  },
  {
    name: 'Light Mode (protanopia)',
    colorScheme: 'light',
    visionDeficiency: 'protanopia',
  },
  {
    name: 'Light Mode (deuteranopia)',
    colorScheme: 'light',
    visionDeficiency: 'deuteranopia',
  },
  {
    name: 'Light Mode (tritanopia)',
    colorScheme: 'light',
    visionDeficiency: 'tritanopia',
  },
  {
    name: 'Light Mode (achromatopsia)',
    colorScheme: 'light',
    visionDeficiency: 'achromatopsia',
  },
];

/**
 * @param {import('puppeteer').Browser} browser
 * @param {string} originalStyles
 *   Original styles that were present in the webpage.
 * @param {TestCase} testCase
 * @returns {Promise<any>}
 */
const pa11yRunner = async (browser, originalStyles, testCase) => {
  const page = await browser.newPage();

  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: testCase.colorScheme }
  ]);

  await page.goto(`file://${FILE_PATH}`);

  let url = FILE_PATH;

  if (testCase.visionDeficiency) {
    const newStyles = replaceStyles(originalStyles, testCase.visionDeficiency);
    url = await overwriteStyles(browser, `file://${FILE_PATH}`, newStyles);
  }

  const results = await pa11y(url, {
    standard: 'WCAG2AAA',
    browser,
    page,
  });

  await page.screenshot({
    path: `${testCase.name}.png`,
  });

  await page.close();
  return results;
};

/**
 * Rip the styles out of a page so that we can modify and insert them back
 * later.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @returns {Promise<string>}
 */
async function getStyles(browser, url) {
  const page = await browser.newPage();
  await page.goto(url);
  const styleHandle = await page.$('style');

  if (!styleHandle) {
    throw Error('no <style> tag found');
  }

  const styles = await page.evaluate((style) => style.textContent, styleHandle);
  await page.close();
  return styles;
}

/**
 * Parses the style string and transforms all hex colors with to a version
 * that's gone through a color deficiency library.
 *
 * @param {string} styles
 * @param {import('@bjornlu/colorblind').Deficiency} visionDeficiency
 * @returns {string}
 */
function replaceStyles(styles, visionDeficiency) {
  const ast = csstree.parse(styles);

  csstree.walk(ast, (node) => {
    if (node.type === 'Raw') {
      let value = node.value;

      if (value.startsWith('#')) {
        node.value = transformHexCantoo(value, visionDeficiency);
      }
    }
  });

  return csstree.generate(ast);
}

/**
 * Uses a library by Cantoo, which appears to be a reputable/sustainable
 * organization in France which even has some public funding.
 *
 * This has closer results to what Chromium or Firefox have when simulating
 * color deficiencies in browser.
 *
 * @param {string} hex
 * @param {import('@bjornlu/colorblind').Deficiency} visionDeficiency
 * @returns {string}
 */
function transformHexCantoo(hex, visionDeficiency) {
  /** @type {(input: import('@cantoo/color-blindness').ColorInput) => string=} */
  let fn = undefined;

  switch (visionDeficiency) {
    case 'achromatopsia':
      fn = achromatopsia;
      break;
    case 'deuteranopia':
      fn = deuteranopia;
      break;
    case 'protanopia':
      fn = protanopia;
      break;
    case 'tritanopia':
      fn = tritanopia;
      break;
    default:
      throw new Error('unknown vision deficiency');
  }

  if (hex.length === 4) {
    hex = `#${hex.charAt(1)}${hex.charAt(1)}${hex.charAt(2)}${hex.charAt(2)}${hex.charAt(3)}${hex.charAt(3)}`;
  }

  return fn(hex);
}

/**
 * This uses a library by one of the maintains of Vite. It's a little more
 * popular too.
 *
 * @param {string} hex
 * @param {import('@bjornlu/colorblind').Deficiency} visionDeficiency
 * @returns {string}
 */
function transformHexBjornlu(hex, visionDeficiency) {
  /** @type {(input: import('@bjornlu/colorblind/dist/types').RGB) => import('@bjornlu/colorblind/dist/types').RGB=} */
  let fn = undefined;

  switch (visionDeficiency) {
    case 'achromatopsia':
      fn = (key) => simulate(key, 'achromatopsia');
      break;
    case 'deuteranopia':
      fn = (key) => simulate(key, 'deuteranopia');
      break;
    case 'protanopia':
      fn = (key) => simulate(key, 'protanopia');
      break;
    case 'tritanopia':
      fn = (key) => simulate(key, 'tritanopia');
      break;
    default:
      throw new Error('unknown vision deficiency');
  }

  let [r, g, b] = convert.hex.rgb(hex);
  const rgb = fn({ r, g, b });
  return `#${convert.rgb.hex(rgb.r, rgb.g, rgb.b)}`;
}

/**
 * Read the page and replace the first `<style>` element with the new styles,
 * then save it to disk. We'll pass the new version to pa11y for the actual
 * test run.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url URL to visit.
 * @param {string} styles New styles to replace content of <style> tag.
 * @returns {Promise<string>}
 *   Resolves to the path to a temporary file with the same contents as the page
 *   given but with the styles replaced with new styles.
 */
async function overwriteStyles(browser, url, styles) {
  const page = await browser.newPage();
  await page.goto(url);
  const styleHandle = await page.$('style');

  if (!styleHandle) {
    throw Error('no <style> tag found');
  }

  await page.evaluate((style, styles) => {
    style.innerHTML = styles;
  }, styleHandle, styles);

  const html = await page.content();
  const output = path.join(tmpdir(), `${randomUUID()}.html`);
  await writeFile(output, html);
  await page.close();
  return output;
}

const browser = await puppeteer.launch();
const originalStyles = await getStyles(browser, `file://${FILE_PATH}`);
const results = [];
let failed = false;

for (const testCase of TEST_CASES) {
  results.push({
    name: testCase.name,
    result: await pa11yRunner(browser, originalStyles, testCase),
  });
}

await browser.close();

for (const { name, result } of results) {
  if (result.issues.length === 0) {
    continue;
  }

  failed = true;

  for (const issue of result.issues) {
    console.error(
      '%s > %s\n%s %s\n%s %s\n%s %s\n',
      styleText(['blue', 'bold'], name),
      styleText(['red', 'bold'], issue.code),
      styleText('yellow', 'Message:'),
      issue.message,
      styleText('yellow', 'Context:'),
      styleText(['gray', 'italic'], issue.context),
      styleText('yellow', 'Selector:'),
      styleText('gray', issue.selector),
    );
  }
}

if (failed) {
  process.exitCode = 1;
}
