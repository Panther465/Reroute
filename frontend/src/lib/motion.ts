// Motion curves for Motion (the CSS versions live in styles/tokens.css). Ease-out for anything entering
// or answering a tap, ease-in-out for things moving on screen, the drawer curve for sheets.
export const EASE_OUT = [0.23, 1, 0.32, 1] as const
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const
/** Only the first half of a split-flap flip: the flap falls away, so it accelerates. */
export const EASE_FALL = [0.4, 0, 1, 1] as const
