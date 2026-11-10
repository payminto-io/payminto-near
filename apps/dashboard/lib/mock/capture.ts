/**
 * Remembers the `?demo=` switches of mock mode for the tab. Kept apart from the rest of the mock, with no imports, so
 * the app shell can call it the moment a page opens: the sign-in redirect drops the query before the mock itself loads.
 */
export const DEMO_KEY = "payminto.demo";

export function captureDemoSwitches(): void {
  if (typeof window === "undefined") return;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("demo");
    if (fromUrl === null) return;
    if (fromUrl === "off" || fromUrl === "") window.sessionStorage.removeItem(DEMO_KEY);
    else window.sessionStorage.setItem(DEMO_KEY, fromUrl);
  } catch {
    // Storage blocked: the switches then apply only while they are in the address bar.
  }
}
