/**
 * The landing page only needs the language toggle.
 *
 * Nothing here is script-rendered, so switching language redraws nothing: the dictionary swaps the
 * markup and there is no second pass to run.
 */

import { setup } from './i18n.ts';

setup(() => undefined);
