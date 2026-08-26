/**
 * Who is looking at the site.
 *
 * Two kinds of visitor, and the important one is the guest. Almost everyone who opens this page
 * arrived from a CV or a repository and wants to see the engine run; making them create an account
 * first would cost more readers than an account is worth. Guest is one click, needs no network, and
 * unlocks everything except persistence.
 *
 * The other kind signs in with an email link. There is no password anywhere in this file, and there
 * is no password in the database either — Supabase issues a one-time link and we never see a
 * credential. That was the whole reason for choosing it over rolling a login.
 *
 * **No SDK.** Supabase's auth and REST endpoints are plain HTTP, so this talks to them with
 * `fetch`. `@supabase/supabase-js` would be about 40 KiB of runtime dependency on a site whose
 * landing page argues that the engine has none, and the four requests below are the entire surface
 * we use. ADR-0007's allowlist stays as it is.
 */

/** Injected at build time by `demo/build.ts` from the deployment's environment. */
interface SiteConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
}

declare global {
  interface Window {
    __TAPEDECK_CONFIG__?: SiteConfig;
  }
}

const GUEST_KEY = 'tapedeck.guest';
const SESSION_KEY = 'tapedeck.session';

export interface GuestSession {
  readonly kind: 'guest';
}

export interface UserSession {
  readonly kind: 'user';
  readonly email: string;
  readonly accessToken: string;
  /** Epoch milliseconds. A token past this is treated as no session at all. */
  readonly expiresAt: number;
}

export type Session = GuestSession | UserSession;

/**
 * The deployment's Supabase settings, or `null` when it has none.
 *
 * `null` is a supported state rather than an error: the site is a static bundle that has to work
 * when someone clones it and opens it locally, and on a preview deployment with no environment
 * configured. Everything that needs an account checks this first and hides rather than breaks.
 */
export function config(): SiteConfig | null {
  const value = window.__TAPEDECK_CONFIG__;
  if (value === undefined) return null;
  if (value.supabaseUrl === '' || value.supabaseAnonKey === '') return null;
  return value;
}

export const accountsAvailable = (): boolean => config() !== null;

function readUserSession(): UserSession | null {
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UserSession>;
    if (
      parsed.kind !== 'user' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    // An expired token is not a session. Checking here rather than on use means a stale tab shows
    // "signed out" instead of failing the first save with a 401 nobody expected.
    if (parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed as UserSession;
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function session(): Session | null {
  const user = readUserSession();
  if (user !== null) return user;
  return window.localStorage.getItem(GUEST_KEY) === '1' ? { kind: 'guest' } : null;
}

export function continueAsGuest(): void {
  window.localStorage.setItem(GUEST_KEY, '1');
}

export function signOut(): void {
  window.localStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(GUEST_KEY);
}

/**
 * Asks Supabase to email a sign-in link.
 *
 * Returns nothing useful on purpose: the response is the same whether or not the address has an
 * account, because a login form that answers "no such user" is a way to enumerate who signed up.
 */
export async function requestSignInLink(email: string, redirectTo: string): Promise<void> {
  const settings = config();
  if (settings === null) throw new Error('this deployment has no account backend configured');

  const response = await fetch(`${settings.supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: settings.supabaseAnonKey },
    body: JSON.stringify({ email, create_user: true, options: { email_redirect_to: redirectTo } }),
  });
  if (!response.ok) {
    // Rate limiting is the one failure worth repeating back, because the reader can act on it.
    if (response.status === 429) throw new Error('Too many attempts. Try again in a few minutes.');
    throw new Error('Could not send the sign-in link. Try again shortly.');
  }
}

/**
 * Completes a sign-in when the browser lands back carrying tokens in the URL fragment.
 *
 * Supabase returns them after `#`, which never reaches a server and never lands in history the way
 * a query string does. The fragment is cleared immediately afterwards so a copied URL cannot hand
 * someone else a live token.
 */
export async function completeSignInFromUrl(): Promise<UserSession | null> {
  const fragment = window.location.hash.slice(1);
  if (fragment === '') return null;
  const params = new URLSearchParams(fragment);
  const accessToken = params.get('access_token');
  if (accessToken === null) return null;

  const settings = config();
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (settings === null) return null;

  const response = await fetch(`${settings.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: settings.supabaseAnonKey, authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { email?: string };
  if (typeof user.email !== 'string') return null;

  const expiresIn = Number(params.get('expires_in') ?? '3600');
  const stored: UserSession = {
    kind: 'user',
    email: user.email,
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
  return stored;
}

/** What the header shows: a name for the current session, or nothing when there is none. */
export function label(current: Session | null): string {
  if (current === null) return '';
  return current.kind === 'guest' ? 'Guest' : current.email;
}
