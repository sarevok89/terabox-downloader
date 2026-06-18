/**
 * TeraBox downloader config — copy this file to terabox_config.ts and fill in your values.
 *
 * How to get your cookie:
 *   1. Open https://www.terabox.com in your browser and log in.
 *   2. Open DevTools → Network tab, refresh the page.
 *   3. Click any request to terabox.com → Headers → Request Headers.
 *   4. Copy the entire value of the "Cookie" header and paste it below.
 *
 * jsToken is optional — it will be auto-extracted from the page if left blank.
 * If auto-extraction fails, grab it from a /api/list request in the Network tab
 * (look for the jsToken query param) and paste it here.
 */

export default {
  cookie: `PASTE_YOUR_FULL_COOKIE_HEADER_VALUE_HERE`,
  jsToken: '',
  base: 'https://www.terabox.com',
};
