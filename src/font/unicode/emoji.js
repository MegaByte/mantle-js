// Emoji properties (UTS #51) from the packed emojiProps trie. Bit flags:
// 1=Emoji, 2=Emoji_Presentation, 4=Emoji_Modifier, 8=Emoji_Modifier_Base,
// 16=Emoji_Component.
import { emojiProps } from "./tables/emojiProps.js";

export const EMOJI = 1, EMOJI_PRESENTATION = 2, EMOJI_MODIFIER = 4, EMOJI_MODIFIER_BASE = 8, EMOJI_COMPONENT = 16;

export const isEmoji = (cp) => (emojiProps.get(cp) & EMOJI) !== 0;
/** Default presentation is emoji (no variation selector needed). */
export const emojiPresentationDefault = (cp) => (emojiProps.get(cp) & EMOJI_PRESENTATION) !== 0;
export const isEmojiModifier = (cp) => (emojiProps.get(cp) & EMOJI_MODIFIER) !== 0;
export const isEmojiModifierBase = (cp) => (emojiProps.get(cp) & EMOJI_MODIFIER_BASE) !== 0;
