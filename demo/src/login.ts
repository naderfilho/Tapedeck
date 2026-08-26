/**
 * The entry page.
 *
 * Its whole job is to get out of the way. The guest button is the first thing focusable, it needs
 * no network, and it is what nearly every visitor will use. This is a portfolio for an engine, and
 * an account wall in front of it would trade readers for a login form nobody asked for.
 */

import {
  accountsAvailable,
  completeSignInFromUrl,
  continueAsGuest,
  requestSignInLink,
} from './auth.ts';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
}

const DESTINATION = '../demo/';

function fail(message: string): void {
  el('error').textContent = message;
}

async function boot(): Promise<void> {
  // Landing here with tokens in the fragment means the reader followed a sign-in link.
  const signedIn = await completeSignInFromUrl();
  if (signedIn !== null) {
    window.location.replace(DESTINATION);
    return;
  }

  el('guest').addEventListener('click', () => {
    continueAsGuest();
    window.location.assign(DESTINATION);
  });

  if (!accountsAvailable()) return;
  el('accounts').hidden = false;

  const form = el('signin') as HTMLFormElement;
  const send = el('send') as HTMLButtonElement;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = (el('email') as HTMLInputElement).value.trim();
    if (email === '') return;

    // Disabled while in flight, because a double submit is how a reader earns a rate limit on a
    // form whose successful response looks identical to its failed one.
    send.disabled = true;
    send.textContent = 'Sending…';
    fail('');

    void requestSignInLink(email, new URL('./', window.location.href).href)
      .then(() => {
        form.hidden = true;
        el('error').textContent = `Check ${email} for a sign-in link.`;
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        send.disabled = false;
        send.textContent = 'Email me a sign-in link';
      });
  });
}

void boot().catch((error: unknown) => {
  fail(String(error));
});
