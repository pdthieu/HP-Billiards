// flat opens a browser context that plays on the 2D table. Desktops open
// in 3D by default (view3d.js); the scenarios measure the flat table in
// canvas pixels, so they pin 2D the way a player would in Settings.
module.exports = async function flat(browser, options) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(() => { try { localStorage.setItem('pool:view', '2d'); } catch { /* unavailable */ } });
  return ctx;
};
