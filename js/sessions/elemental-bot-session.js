/**
 * sessions/elemental-bot-session.js
 * Elemental Chess against the computer: the two mixins, stacked.
 *
 * Its own file, small as it is, so that neither half has to import the other.
 * A plain bot game never loads the variant, and two people playing the variant
 * on one device never load the search — which is the whole reason app.js
 * imports each of these session modules only at the moment a game needs one.
 *
 * The order is the load-bearing part, and it is explained at length in both
 * mixins: the bot goes OUTSIDE, so the elemental layer has finished with a
 * move — fire, lightning, the lot — before the bot is handed the position to
 * think about.
 */

import { LocalSession } from './local-session.js';
import { withElemental } from './elemental-session.js';
import { withBot } from './bot-session.js';

export const ElementalBotSession = withBot(withElemental(LocalSession));

export default ElementalBotSession;
