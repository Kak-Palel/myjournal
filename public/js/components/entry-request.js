// Request bodies for the entry view's two streaming calls (POST /entries/:id/reply and /wrap-up, ARCHITECTURE §6).
// Pure: the date comes in as an argument, so the shape is unit-tested without a browser.
import { todayString } from '../lib/ui.js';

/**
 * The browser's own calendar date goes with every reply and wrap-up ("Today is ..." in the prompt). Without it the server
 * uses its clock, which is a day off around midnight when it runs in another time zone (a container in UTC).
 * @param {boolean} [regenerate] replace the last reply instead of answering the last message
 * @param {Date} [now]
 */
export function replyBody(regenerate = false, now = new Date()) {
  return { regenerate: Boolean(regenerate), today: todayString(now) };
}

/** @param {Date} [now] */
export function wrapUpBody(now = new Date()) {
  return { today: todayString(now) };
}
