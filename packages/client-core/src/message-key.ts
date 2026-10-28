import type { ChatMessage } from '@crocodile/protocol';

/** A message is told apart by who wrote it and its id: authors choose their own ids. */
export const messageKey = (m: Pick<ChatMessage, 'author' | 'id'>) => `${m.author}/${m.id}`;
