// Rod v0.116.2 applies LaptopWithMDPIScreen by default. Preserve its UA
// for a fresh login; an existing session must keep its own recorded UA.
export const ROD_LOGIN_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

export function browserUserAgent(session) {
  return session?.userAgent ?? ROD_LOGIN_USER_AGENT;
}

// These are the actual CDP arguments emitted by Rod's default device. In
// particular screenWidth/screenHeight/platform/UA metadata were not overridden.
export async function applyRodDevice(context, page, session) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800,
    deviceScaleFactor: 1, mobile: false, screenOrientation: { angle: 90, type: 'landscapePrimary' } });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 5 });
  await cdp.send('Network.setUserAgentOverride', { userAgent: browserUserAgent(session), acceptLanguage: 'en' });
  return cdp;
}
