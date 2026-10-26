/**
 * What removing a channel does, said before every Remove button: the channel page and Settings ask with the
 * title `Remove <label>?` and this sentence beneath it, so both say the same thing.
 */
export const REMOVE_CONSEQUENCE =
  "This disconnects the bot and deletes its keys. Its conversations stay readable under Messaging until you delete them.";

/** The question a Remove confirmation asks, naming the channel by its label. */
export const removeChannelTitle = (label: string): string => `Remove ${label}?`;
